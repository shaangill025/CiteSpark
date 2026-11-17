import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { LeaseError, type Job, type JobStore, type Lease } from "./jobs.ts";

export type Availability = "available" | "unavailable";

/**
 * Another availability report for the same identity that an importer merged into a record when it
 * deduplicated texts (MIG-01, Q37). `text` says what that report carried relative to the record's
 * text: the `same` text, a `truncated` (weaker, nonempty) text, or no text (`empty`).
 */
export interface AvailabilityReport {
  availability: Availability;
  text: "same" | "truncated" | "empty";
}

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
   * transaction against the persisted versions of this identity (see `isWeakerText`):
   *
   * - Text weaker than a stored version adds no version. Account membership is recorded, and so is
   *   an observation with the incoming availability against the retained fuller version, whose
   *   `evidence` (`{"kind":"retained-fuller","incoming":"empty"|"truncated","textCaptured":false}`)
   *   states that this observation did not capture that text.
   * - An `unavailable` record with empty text and no stored text records the identity, membership,
   *   and an `unavailable` observation of an explicit empty snapshot (`completeness` `none`,
   *   evidence `{"kind":"unavailable-no-text","textCaptured":false}`). No text is invented.
   * - An `available` record with empty text for an identity with no stored source writes nothing.
   *
   * Importers set this; live capture adapters leave it unset.
   */
  retainFuller?: boolean;
  /**
   * Other availability reports for this identity that an importer folded into this record while
   * deduplicating texts. With `retainFuller`, every report of a record is merged, order-free and
   * idempotently, into the one observation per job and version: at most one report per
   * availability is kept (the one that carried the most text). When both availabilities are
   * reported, the observation's `availability` is `conflicting` and its `evidence` is
   * `{"kind":"conflicting-availability","chronology":"unknown","textCaptured":…,"reports":[…]}`;
   * the order of reports in a file is not treated as time.
   */
  alsoReported?: readonly AvailabilityReport[];
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
  /**
   * `retainFuller` records whose text was weaker than a stored version: membership and
   * availability evidence against the retained version, no new version.
   */
  weakerSkipped: number;
  /**
   * `retainFuller` records reported unavailable with no text and no stored text: identity,
   * membership, and an unavailable observation of an empty snapshot. Not counted in `newVersions`.
   */
  unavailableNoText: number;
  /** `retainFuller` records reported available with no text and no stored source: nothing written. */
  noContentSkipped: number;
  /** Records of a trashed or purged source: not recaptured, nothing written (DAT-03, Q50). */
  suppressed: number;
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
    if (r.alsoReported !== undefined) {
      if (!Array.isArray(r.alsoReported)) fail(`record ${i}`);
      for (const a of r.alsoReported) {
        if (
          typeof a !== "object" ||
          a === null ||
          (a.availability !== "available" && a.availability !== "unavailable") ||
          (a.text !== "same" && a.text !== "truncated" && a.text !== "empty")
        ) {
          fail(`record ${i}`);
        }
      }
    }
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
        const also = r.alsoReported?.length ? canonicalAlso(r.alsoReported) : null;
        if (r.availability === "unavailable" || r.retainFuller === true || also) {
          fields.push(r.availability ?? "available", r.retainFuller === true);
        }
        if (also) fields.push(also);
        return fields;
      }),
    ),
  );

const canonicalAlso = (reports: readonly AvailabilityReport[]): string[][] =>
  [...new Set(reports.map((a) => `${a.availability}\u0000${a.text}`))]
    .sort()
    .map((k) => k.split("\u0000"));

/** What one availability report carried relative to the observed version's text. */
type ReportText = "captured" | "truncated" | "empty" | "none";
interface ObservedReport {
  availability: Availability;
  text: ReportText;
}
const TEXT_RANK: Record<ReportText, number> = { none: 0, empty: 1, truncated: 2, captured: 3 };

/**
 * Canonical report set of one observation: one report per availability, keeping the one that
 * carried the most text, sorted. A join (commutative, associative, idempotent), so merging reports
 * in any order, or more than once, gives the same set.
 */
function joinReports(reports: readonly ObservedReport[]): ObservedReport[] {
  const best = new Map<Availability, ReportText>();
  for (const r of reports) {
    const prior = best.get(r.availability);
    if (prior === undefined || TEXT_RANK[r.text] > TEXT_RANK[prior])
      best.set(r.availability, r.text);
  }
  return [...best]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([availability, text]) => ({ availability, text }));
}

/**
 * Observation columns for a canonical report set. A single report keeps the established shapes
 * (`null`, `retained-fuller`, `unavailable-no-text`); both availabilities are an explicit conflict.
 */
function encodeReports(reports: readonly ObservedReport[]): {
  availability: string;
  evidence: string | null;
} {
  if (reports.length > 1) {
    return {
      availability: "conflicting",
      evidence: JSON.stringify({
        kind: "conflicting-availability",
        chronology: "unknown",
        textCaptured: reports.some((r) => r.text === "captured"),
        reports,
      }),
    };
  }
  const [r] = reports as [ObservedReport];
  if (r.text === "empty" || r.text === "truncated") {
    return {
      availability: r.availability,
      evidence: JSON.stringify({ kind: "retained-fuller", incoming: r.text, textCaptured: false }),
    };
  }
  if (r.text === "none" && r.availability === "unavailable") {
    return {
      availability: r.availability,
      evidence: JSON.stringify({ kind: "unavailable-no-text", textCaptured: false }),
    };
  }
  return { availability: r.availability, evidence: null };
}

/** Reports a stored observation row holds, or `null` when its evidence is not a shape we merge. */
function decodeReports(
  availability: string,
  evidence: string | null,
  versionText: string,
): ObservedReport[] | null {
  const avail = (v: unknown): v is Availability => v === "available" || v === "unavailable";
  if (evidence === null) {
    return avail(availability)
      ? [{ availability, text: versionText === "" ? "none" : "captured" }]
      : null;
  }
  let e: unknown;
  try {
    e = JSON.parse(evidence);
  } catch {
    return null;
  }
  if (typeof e !== "object" || e === null) return null;
  const o = e as Record<string, unknown>;
  if (o.kind === "retained-fuller" && avail(availability)) {
    return o.incoming === "empty" || o.incoming === "truncated"
      ? [{ availability, text: o.incoming }]
      : null;
  }
  if (o.kind === "unavailable-no-text" && avail(availability)) {
    return [{ availability, text: "none" }];
  }
  if (o.kind === "conflicting-availability" && Array.isArray(o.reports)) {
    const out: ObservedReport[] = [];
    for (const r of o.reports as unknown[]) {
      const x = r as Record<string, unknown> | null;
      if (!x || !avail(x.availability) || typeof x.text !== "string" || !(x.text in TEXT_RANK)) {
        return null;
      }
      out.push({ availability: x.availability, text: x.text as ReportText });
    }
    return out;
  }
  return null;
}

const TRUNCATION = /(…|\.\.\.)$/;

/** The content a text carries, without trailing whitespace or a trailing truncation marker. */
const qualityOf = (text: string): { head: string; truncated: boolean } => {
  const trimmed = text.trimEnd();
  const truncated = TRUNCATION.test(trimmed);
  return { head: truncated ? trimmed.replace(TRUNCATION, "").trimEnd() : trimmed, truncated };
};

/**
 * Whether `incoming` is weaker than one of the `stored` texts of the same source (MIG-01, T09).
 * The comparison is by content, never by raw length (a trailing `…` or `...` marks a truncation
 * and is not content):
 *
 * - empty text is weaker than any nonempty stored text;
 * - text whose content is a strict prefix of a stored text's content is weaker;
 * - an ellipsis-marked truncation is weaker than a stored text with the same content, so
 *   `abc...` is weaker than both `abcd` and `abc`.
 *
 * Identical text is not weaker (it is the same version), and neither is text that differs from
 * every stored text other than by such a prefix: that is a distinct version, kept alongside.
 */
export function isWeakerText(incoming: string, stored: readonly string[]): boolean {
  if (incoming === "") return stored.some((t) => t !== "");
  const a = qualityOf(incoming);
  return stored.some((t) => {
    if (t === incoming || t === "") return false;
    const b = qualityOf(t);
    if (!b.head.startsWith(a.head)) return false;
    return b.head.length > a.head.length || a.truncated;
  });
}

/**
 * Index of the stored version that makes `incoming` weaker and is retained in its place: the one
 * carrying the most content, a complete text before a marked truncation of the same content, then
 * the smaller text (by code unit), so the choice depends on content, not on storage or file order.
 * `null` when `incoming` is not weaker than any stored version.
 */
export function retainedVersion(incoming: string, stored: readonly string[]): number | null {
  let best: number | null = null;
  stored.forEach((t, i) => {
    if (!isWeakerText(incoming, [t])) return;
    if (best === null) {
      best = i;
      return;
    }
    const b = qualityOf(stored[best]!);
    const c = qualityOf(t);
    if (
      c.head.length > b.head.length ||
      (c.head.length === b.head.length && b.truncated && !c.truncated) ||
      (c.head.length === b.head.length && b.truncated === c.truncated && t < stored[best]!)
    ) {
      best = i;
    }
  });
  return best;
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
      unavailableNoText: 0,
      noContentSkipped: 0,
      suppressed: 0,
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
      `INSERT INTO source_version (source_id, content_hash, text, completeness, published_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (source_id, content_hash) DO NOTHING`,
    );
    const getVersion = this.db.prepare(
      "SELECT id FROM source_version WHERE source_id = ? AND content_hash = ?",
    );
    const insObservation = this.db.prepare(
      `INSERT INTO observation (source_id, version_id, job_id, observed_at, method, adapter_version, availability, evidence, capture_page_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    const isSuppressed = this.db.prepare(
      `SELECT 1 FROM source WHERE source_type = ? AND platform_id = ?
         AND (trashed_at IS NOT NULL OR purged_at IS NOT NULL)`,
    );
    const findObservation = this.db.prepare(
      `SELECT id, availability, evidence FROM observation
       WHERE job_id = ? AND version_id = ? AND capture_page_id IS NOT NULL`,
    );
    const setObservation = this.db.prepare(
      "UPDATE observation SET availability = ?, evidence = ? WHERE id = ?",
    );
    /**
     * Merge reports into this job's one observation of a version (`retainFuller` records only).
     * Returns 1 when a new observation row was inserted, 0 when an existing row absorbed them. The
     * existing row keeps its time and page; only its availability and evidence gain the reports.
     */
    const observeReports = (
      sourceId: string,
      versionId: number,
      versionText: string,
      reports: readonly ObservedReport[],
    ): number => {
      const prior = findObservation.get(jobId, versionId) as
        { id: number; availability: string; evidence: string | null } | undefined;
      if (prior === undefined) {
        const e = encodeReports(joinReports(reports));
        return insObservation.run(
          sourceId,
          versionId,
          jobId,
          iso,
          method,
          adapter,
          e.availability,
          e.evidence,
          pageId,
        ).changes;
      }
      const held = decodeReports(prior.availability, prior.evidence, versionText);
      if (held === null) return 0;
      const e = encodeReports(joinReports([...held, ...reports]));
      if (e.availability !== prior.availability || e.evidence !== prior.evidence) {
        setObservation.run(e.availability, e.evidence, prior.id);
      }
      return 0;
    };
    /** Every report a record carries, with `same` mapped to what it means for the target version. */
    const reportsOf = (r: CaptureRecord, same: ReportText, all?: ReportText): ObservedReport[] =>
      [
        { availability: r.availability ?? "available", text: "same" as const },
        ...(r.alsoReported ?? []),
      ].map((a) => ({
        availability: a.availability,
        text: all ?? (a.text === "same" ? same : a.text),
      }));

    const storedVersions = this.db.prepare(
      "SELECT id, text FROM source_version WHERE source_id = ? ORDER BY id",
    );
    const observe = (
      sourceId: string,
      versionId: number,
      r: CaptureRecord,
      evidence: string | null,
    ): number =>
      insObservation.run(
        sourceId,
        versionId,
        jobId,
        iso,
        method,
        adapter,
        r.availability ?? "available",
        evidence,
        pageId,
      ).changes;
    const addVersion = (sourceId: string, r: CaptureRecord, completeness: string) => {
      const textHash = sha256(r.text);
      const added = insVersion.run(
        sourceId,
        textHash,
        r.text,
        completeness,
        r.publishedAt ?? null,
        iso,
      ).changes;
      const { id } = getVersion.get(sourceId, textHash) as { id: number };
      return { id, added };
    };

    let newSources = 0;
    let newVersions = 0;
    let newRecords = 0;
    let weakerSkipped = 0;
    let unavailableNoText = 0;
    let noContentSkipped = 0;
    let suppressed = 0;
    const half = Math.floor(page.records.length / 2);
    page.records.forEach((r, i) => {
      if (i === half) fault("mid-page");
      // Trashed and purged sources are not recaptured until restored (DAT-03, Q50). Checked on the
      // canonical identity so a purged tombstone keeps suppressing it.
      if (isSuppressed.get(r.sourceType, r.platformId) !== undefined) {
        suppressed++;
        return;
      }
      if (r.retainFuller === true) {
        const stored = findSource.get(r.sourceType, r.platformId) as { id: string } | undefined;
        const versions = stored
          ? (storedVersions.all(stored.id) as { id: number; text: string }[])
          : [];
        const retained = retainedVersion(
          r.text,
          versions.map((v) => v.text),
        );
        if (stored && retained !== null) {
          // Availability and import provenance are evidence independent of text quality; the
          // observation points at the retained version but says its text was not captured here.
          weakerSkipped++;
          const kept = versions[retained]!;
          const reports = reportsOf(r, r.text === "" ? "empty" : "truncated");
          observeReports(stored.id, kept.id, kept.text, reports);
          upMembership.run(page.accountId, page.collectionId, stored.id, iso, iso, jobId, jobId);
          return;
        }
        const reports = reportsOf(r, r.text === "" ? "none" : "captured");
        if (r.text === "" && reports.some((a) => a.availability === "unavailable")) {
          const { id: sourceId, created } = sourceIdFor(r);
          if (created) newSources++;
          unavailableNoText++;
          const { id: versionId } = addVersion(sourceId, r, "none");
          newRecords += observeReports(sourceId, versionId, "", reportsOf(r, "none", "none"));
          upMembership.run(page.accountId, page.collectionId, sourceId, iso, iso, jobId, jobId);
          return;
        }
        if (!stored && r.text === "") {
          noContentSkipped++;
          return;
        }
        const { id: sourceId, created } = sourceIdFor(r);
        if (created) newSources++;
        const { id: versionId, added } = addVersion(sourceId, r, "unknown");
        newVersions += added;
        newRecords += observeReports(sourceId, versionId, r.text, reports);
        upMembership.run(page.accountId, page.collectionId, sourceId, iso, iso, jobId, jobId);
        return;
      }
      const { id: sourceId, created } = sourceIdFor(r);
      if (created) newSources++;
      const { id: versionId, added } = addVersion(sourceId, r, "unknown");
      newVersions += added;
      newRecords += observe(sourceId, versionId, r, null);
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
      unavailableNoText,
      noContentSkipped,
      suppressed,
      cancelRequested,
    };
  }
}
