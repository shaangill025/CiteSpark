import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { LeaseError, type Job, type JobStore, type Lease } from "./jobs.ts";

/** One captured item, as produced by any capture adapter or importer. Platform IDs are strings (CAP-02). */
export interface CaptureRecord {
  /** Source kind, for example `x_post`. Together with `platformId` it forms the canonical identity. */
  sourceType: string;
  platformId: string;
  text: string;
  authorId?: string | null;
  authorHandle?: string | null;
  canonicalUrl?: string | null;
  publishedAt?: string | null;
  /** Availability reported with this observation; defaults to `available`. */
  availability?: "available" | "unavailable";
  /**
   * Never let weaker content displace a fuller stored copy (MIG-01, T09). Decided inside the commit
   * transaction against the persisted versions of this identity: text that is empty, or a
   * truncation of a longer stored version, adds no version or observation, but account membership
   * is still recorded. An empty text for an identity with no stored source writes nothing.
   * Importers set this; live capture adapters leave it unset.
   */
  retainFuller?: boolean;
}

/** One page handed over for commit. Adapter-agnostic: cursors are opaque strings. */
export interface CapturePage {
  /** Identifies one pass over the collection from its top. A resumed job starts a new pass (ADR 0005). */
  passId: string;
  accountId: string;
  collectionId: string;
  /** Cursor the page was requested with; `null` for the first page of a pass. */
  cursorIn: string | null;
  /** Continuation returned with the page; `null` marks the recognized end of the collection (CAP-06). */
  cursorOut: string | null;
  adapter: { id: string; version: string };
  /** How the observations were obtained; defaults to `capture`. Importers pass `import` (MIG-01). */
  method?: "capture" | "import";
  records: readonly CaptureRecord[];
}

export interface CommitResult {
  status: "committed" | "replayed";
  passId: string;
  /** Zero-based position of the page within its pass. */
  seq: number;
  /** Continuation after this page. */
  cursor: string | null;
  /** The page carried no continuation, so the job reached its recognized end and is `complete`. */
  ended: boolean;
  /** Records whose version this job had not observed before. Zero while a resumed pass is catching up. */
  newRecords: number;
  newSources: number;
  newVersions: number;
  /** `retainFuller` records whose text was weaker than a stored version: membership only. */
  weakerSkipped: number;
  /** `retainFuller` records with no text and no stored source: nothing written. */
  noContentSkipped: number;
  cancelRequested: boolean;
}

export type FaultPoint = "mid-page" | "before-commit" | "after-commit";

export interface CommitOptions {
  /** Test seam for crash injection (T01). Called inside the transaction except for `after-commit`. */
  onFaultPoint?: (point: FaultPoint) => void;
}

export interface CaptureSummary {
  pages: number;
  passes: number;
  distinctSources: number;
  adapters: string[];
  end: {
    passId: string;
    seq: number;
    cursorIn: string | null;
    adapter: string;
    committedAt: string;
  } | null;
}

export class CursorMismatchError extends Error {}
export class ReplayConflictError extends Error {}
export class AccountMismatchError extends Error {}
export class InvalidPageError extends Error {}

interface PassRow {
  cursor: string | null;
  pages: number;
  ended_at: string | null;
}

interface PageRow {
  seq: number;
  cursor_out: string | null;
  content_hash: string;
}

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const optionalString = (v: unknown): boolean =>
  v === undefined || v === null || typeof v === "string";

function validate(page: CapturePage): void {
  const fail = (what: string): never => {
    throw new InvalidPageError(`invalid capture page: ${what}`);
  };
  if (!nonEmpty(page.passId)) fail("passId");
  if (!nonEmpty(page.accountId) || !nonEmpty(page.collectionId)) fail("account binding");
  if (page.cursorIn !== null && !nonEmpty(page.cursorIn)) fail("cursorIn");
  if (page.cursorOut !== null && !nonEmpty(page.cursorOut)) fail("cursorOut");
  if (!nonEmpty(page.adapter?.id) || !nonEmpty(page.adapter?.version)) fail("adapter");
  if (page.method !== undefined && page.method !== "capture" && page.method !== "import") {
    fail("method");
  }
  if (!Array.isArray(page.records)) fail("records");
  page.records.forEach((r, i) => {
    if (!nonEmpty(r.sourceType) || !nonEmpty(r.platformId) || typeof r.text !== "string") {
      fail(`record ${i}`);
    }
    for (const f of [r.authorId, r.authorHandle, r.canonicalUrl, r.publishedAt]) {
      if (!optionalString(f)) fail(`record ${i}`);
    }
    if (
      r.availability !== undefined &&
      r.availability !== "available" &&
      r.availability !== "unavailable"
    ) {
      fail(`record ${i}`);
    }
    if (r.retainFuller !== undefined && typeof r.retainFuller !== "boolean") fail(`record ${i}`);
  });
}

const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/**
 * Page fingerprint for replay detection. Optional fields are appended only when they differ from
 * their defaults, so fingerprints already persisted for capture pages stay valid.
 */
const contentHash = (records: readonly CaptureRecord[]): string =>
  sha256(
    JSON.stringify(
      records.map((r) => {
        const fields: unknown[] = [
          r.sourceType,
          r.platformId,
          r.text,
          r.authorId ?? null,
          r.authorHandle ?? null,
          r.canonicalUrl ?? null,
          r.publishedAt ?? null,
        ];
        if (r.availability === "unavailable" || r.retainFuller === true) {
          fields.push(r.availability ?? "available", r.retainFuller === true);
        }
        return fields;
      }),
    ),
  );

const TRUNCATION = /(…|\.\.\.)$/;

/**
 * Whether `incoming` is weaker than one of the `stored` texts of the same source: empty while a
 * stored text is not, or a truncation (optionally ellipsis-terminated) of a longer stored text. A
 * stored copy that is itself ellipsis-terminated is not treated as fuller than anything it prefixes.
 */
export function isWeakerText(incoming: string, stored: readonly string[]): boolean {
  if (incoming === "") return stored.some((t) => t !== "");
  const head = incoming.trimEnd().replace(TRUNCATION, "");
  return stored.some(
    (t) => !TRUNCATION.test(t.trimEnd()) && t.length > incoming.length && t.startsWith(head),
  );
}

/**
 * Commits capture pages: records, observations, membership, and the continuation cursor in one
 * transaction (CAP-03). Fenced by the job lease. Time is injected as epoch ms.
 */
export class CaptureStore {
  private readonly db: Database.Database;
  private readonly jobs: JobStore;

  constructor(db: Database.Database, jobs: JobStore) {
    this.db = db;
    this.jobs = jobs;
  }

  /**
   * Persist one page and advance the cursor only when every record is durable.
   *
   * - A page already committed in the same pass is acknowledged without writing anything.
   * - A new pass must start at the top (`cursorIn === null`). Records it re-reads are already
   *   canonical, so they add no source, version, observation, or membership rows.
   * - Within a pass, a page must start at the previous page's continuation; skips are rejected.
   * - A page bound to another account or collection is refused before any write, and the job is
   *   paused (CAP-02).
   * - A page without a continuation completes the job with termination evidence (CAP-06).
   *
   * `lease` is the token `JobStore.acquire` returned for this attempt. Retain it; never rebuild it
   * from `JobStore.get`, which would let a stale worker impersonate a newer acquisition. It is
   * checked against the live owner, generation and expiry inside the commit transaction. Only a
   * `complete` job, which holds no lease, accepts `null` (or any token), and then only to
   * acknowledge a page it already committed. Time is validated before anything is read.
   */
  commitPage(
    jobId: string,
    lease: Lease | null,
    nowMs: number,
    page: CapturePage,
    options: CommitOptions = {},
  ): CommitResult {
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError(`time must be a non-negative safe integer (ms), got ${nowMs}`);
    }
    validate(page);
    const fault = options.onFaultPoint ?? (() => {});
    const outcome = this.db
      .transaction((): CommitResult | AccountMismatchError => {
        const job = this.jobs.get(jobId);
        // A completed job holds no lease; it still acknowledges a re-sent page, which writes nothing.
        if (job.state === "complete") {
          const mismatch = this.bindingError(job, page);
          if (mismatch) throw mismatch;
          return this.replayOf(job, page) ?? this.completedRejection(jobId);
        }
        if (lease === null) {
          throw new LeaseError(
            `job ${jobId} is ${job.state}; committing a page needs its live lease`,
          );
        }
        // Validation and every write below share one IMMEDIATE transaction: the retained lease
        // cannot expire or be superseded between the check and the commit.
        return this.jobs.withLease(jobId, lease, nowMs, (live) => {
          const mismatch = this.bindingError(live, page);
          if (mismatch) {
            // Refuse before any capture write; pause in the same transaction (CAP-02).
            this.jobs.transition(jobId, lease, nowMs, "paused", mismatch.message);
            return mismatch;
          }
          return this.replayOf(live, page) ?? this.commitNew(live, lease, nowMs, page, fault);
        });
      })
      .immediate();
    if (outcome instanceof AccountMismatchError) throw outcome;
    if (outcome.status === "committed") fault("after-commit");
    return outcome;
  }

  summary(jobId: string): CaptureSummary {
    const n = (sql: string): number => (this.db.prepare(sql).get(jobId) as { n: number }).n;
    const end = this.db
      .prepare(
        `SELECT pass_id, seq, cursor_in, adapter_id || '@' || adapter_version adapter, committed_at
         FROM capture_page WHERE job_id = ? AND cursor_out IS NULL ORDER BY id LIMIT 1`,
      )
      .get(jobId) as
      | {
          pass_id: string;
          seq: number;
          cursor_in: string | null;
          adapter: string;
          committed_at: string;
        }
      | undefined;
    return {
      pages: n("SELECT COUNT(*) n FROM capture_page WHERE job_id = ?"),
      passes: n("SELECT COUNT(*) n FROM capture_pass WHERE job_id = ?"),
      distinctSources: n("SELECT COUNT(DISTINCT source_id) n FROM observation WHERE job_id = ?"),
      adapters: (
        this.db
          .prepare(
            "SELECT DISTINCT adapter_id || '@' || adapter_version a FROM capture_page WHERE job_id = ? ORDER BY a",
          )
          .all(jobId) as { a: string }[]
      ).map((r) => r.a),
      end: end
        ? {
            passId: end.pass_id,
            seq: end.seq,
            cursorIn: end.cursor_in,
            adapter: end.adapter,
            committedAt: end.committed_at,
          }
        : null,
    };
  }

  private bindingError(job: Job, page: CapturePage): AccountMismatchError | null {
    if (job.accountId === page.accountId && job.collectionId === page.collectionId) return null;
    return new AccountMismatchError(
      `account mismatch: job ${job.id} is bound to ${job.accountId}/${job.collectionId}, page belongs to ${page.accountId}/${page.collectionId}`,
    );
  }

  private completedRejection(jobId: string): never {
    throw new LeaseError(`job ${jobId} is complete and accepts only replays of committed pages`);
  }

  /** Acknowledges a page already committed in the same pass, or returns null for a new page. */
  private replayOf(job: Job, page: CapturePage): CommitResult | null {
    const prior = this.db
      .prepare(
        "SELECT seq, cursor_out, content_hash FROM capture_page WHERE job_id = ? AND pass_id = ? AND page_key = ?",
      )
      .get(job.id, page.passId, page.cursorIn ?? "") as PageRow | undefined;
    if (!prior) return null;
    if (prior.cursor_out !== page.cursorOut) {
      throw new CursorMismatchError(
        `page ${prior.seq} of pass ${page.passId} replayed with a different continuation`,
      );
    }
    if (prior.content_hash !== contentHash(page.records)) {
      throw new ReplayConflictError(
        `page ${prior.seq} of pass ${page.passId} replayed with different records`,
      );
    }
    return {
      status: "replayed",
      passId: page.passId,
      seq: prior.seq,
      cursor: prior.cursor_out,
      ended: prior.cursor_out === null,
      newRecords: 0,
      newSources: 0,
      newVersions: 0,
      weakerSkipped: 0,
      noContentSkipped: 0,
      cancelRequested: job.cancelRequested,
    };
  }

  private commitNew(
    job: Job,
    lease: Lease,
    nowMs: number,
    page: CapturePage,
    fault: (point: FaultPoint) => void,
  ): CommitResult {
    const jobId = job.id;
    const pageKey = page.cursorIn ?? "";
    const hash = contentHash(page.records);
    const iso = new Date(nowMs).toISOString();
    const pass = this.db
      .prepare("SELECT cursor, pages, ended_at FROM capture_pass WHERE job_id = ? AND pass_id = ?")
      .get(jobId, page.passId) as PassRow | undefined;
    if (!pass) {
      if (page.cursorIn !== null) {
        throw new CursorMismatchError(
          `pass ${page.passId} must start at the top of the collection`,
        );
      }
      this.db
        .prepare("INSERT INTO capture_pass (job_id, pass_id, started_at) VALUES (?, ?, ?)")
        .run(jobId, page.passId, iso);
    } else if (pass.ended_at !== null || pass.cursor !== page.cursorIn) {
      throw new CursorMismatchError(
        `pass ${page.passId} continues at ${pass.ended_at !== null ? "its end" : pass.cursor}, page starts at ${page.cursorIn}`,
      );
    }
    const seq = pass?.pages ?? 0;
    const adapter = `${page.adapter.id}@${page.adapter.version}`;
    const method = page.method ?? "capture";

    const pageId = Number(
      this.db
        .prepare(
          `INSERT INTO capture_page (job_id, pass_id, seq, page_key, cursor_in, cursor_out, content_hash,
             record_count, new_records, adapter_id, adapter_version, committed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        )
        .run(
          jobId,
          page.passId,
          seq,
          pageKey,
          page.cursorIn,
          page.cursorOut,
          hash,
          page.records.length,
          page.adapter.id,
          page.adapter.version,
          iso,
        ).lastInsertRowid,
    );

    this.db
      .prepare("INSERT OR IGNORE INTO collection (account_id, id) VALUES (?, ?)")
      .run(page.accountId, page.collectionId);
    const findSource = this.db.prepare(
      "SELECT id FROM source WHERE source_type = ? AND platform_id = ?",
    );
    const idTaken = this.db.prepare("SELECT 1 FROM source WHERE id = ?");
    const insSource = this.db.prepare(
      `INSERT INTO source (id, source_type, platform_id, canonical_url, author_id, author_handle, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insVersion = this.db.prepare(
      `INSERT INTO source_version (source_id, content_hash, text, published_at, created_at)
       VALUES (?, ?, ?, ?, ?) ON CONFLICT (source_id, content_hash) DO NOTHING`,
    );
    const getVersion = this.db.prepare(
      "SELECT id FROM source_version WHERE source_id = ? AND content_hash = ?",
    );
    const insObservation = this.db.prepare(
      `INSERT INTO observation (source_id, version_id, job_id, observed_at, method, adapter_version, availability, capture_page_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (job_id, version_id) WHERE capture_page_id IS NOT NULL DO NOTHING`,
    );
    /**
     * The canonical identity is (source_type, platform_id). Reuse whatever ID it was stored under
     * (an importer or older build may use another scheme). A new identity gets a derived ID whose
     * type part is escaped so distinct identities cannot derive the same ID; if an unrelated row
     * still holds it, a deterministic suffix is added rather than attaching to that row.
     */
    const sourceIdFor = (r: CaptureRecord): { id: string; created: boolean } => {
      const existing = findSource.get(r.sourceType, r.platformId) as { id: string } | undefined;
      if (existing) return { id: existing.id, created: false };
      const base = `${encodeURIComponent(r.sourceType)}:${r.platformId}`;
      let id = base;
      for (let n = 1; idTaken.get(id) !== undefined; n++) id = `${base}#${n}`;
      insSource.run(
        id,
        r.sourceType,
        r.platformId,
        r.canonicalUrl ?? null,
        r.authorId ?? null,
        r.authorHandle ?? null,
        iso,
      );
      return { id, created: true };
    };
    // A job re-reading a source it already recorded changes nothing (replay across passes).
    const upMembership = this.db.prepare(
      `INSERT INTO membership (account_id, collection_id, source_id, first_observed_at, last_observed_at, first_job_id, last_job_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (account_id, collection_id, source_id) DO UPDATE
         SET last_observed_at = excluded.last_observed_at, last_job_id = excluded.last_job_id
         WHERE membership.last_job_id IS NOT excluded.last_job_id`,
    );

    const storedTexts = this.db.prepare("SELECT text FROM source_version WHERE source_id = ?");

    let newSources = 0;
    let newVersions = 0;
    let newRecords = 0;
    let weakerSkipped = 0;
    let noContentSkipped = 0;
    const half = Math.floor(page.records.length / 2);
    page.records.forEach((r, i) => {
      if (i === half) fault("mid-page");
      if (r.retainFuller === true) {
        const stored = findSource.get(r.sourceType, r.platformId) as { id: string } | undefined;
        if (!stored && r.text === "") {
          noContentSkipped++;
          return;
        }
        if (stored) {
          const texts = (storedTexts.all(stored.id) as { text: string }[]).map((v) => v.text);
          if (isWeakerText(r.text, texts)) {
            weakerSkipped++;
            upMembership.run(page.accountId, page.collectionId, stored.id, iso, iso, jobId, jobId);
            return;
          }
        }
      }
      const { id: sourceId, created } = sourceIdFor(r);
      if (created) newSources++;
      const textHash = sha256(r.text);
      newVersions += insVersion.run(sourceId, textHash, r.text, r.publishedAt ?? null, iso).changes;
      const { id: versionId } = getVersion.get(sourceId, textHash) as { id: number };
      newRecords += insObservation.run(
        sourceId,
        versionId,
        jobId,
        iso,
        method,
        adapter,
        r.availability ?? "available",
        pageId,
      ).changes;
      upMembership.run(page.accountId, page.collectionId, sourceId, iso, iso, jobId, jobId);
    });

    const ended = page.cursorOut === null;
    this.db.prepare("UPDATE capture_page SET new_records = ? WHERE id = ?").run(newRecords, pageId);
    this.db
      .prepare(
        "UPDATE capture_pass SET cursor = ?, pages = pages + 1, ended_at = ? WHERE job_id = ? AND pass_id = ?",
      )
      .run(page.cursorOut, ended ? iso : null, jobId, page.passId);
    const cancelRequested = this.jobs.checkpoint(jobId, lease, nowMs, { cursor: page.cursorOut });
    if (ended) {
      this.jobs.transition(
        jobId,
        lease,
        nowMs,
        "complete",
        `recognized end: pass ${page.passId} page ${seq} returned no continuation (${adapter})`,
      );
    }

    fault("before-commit");
    return {
      status: "committed",
      passId: page.passId,
      seq,
      cursor: page.cursorOut,
      ended,
      newRecords,
      newSources,
      newVersions,
      weakerSkipped,
      noContentSkipped,
      cancelRequested,
    };
  }
}
