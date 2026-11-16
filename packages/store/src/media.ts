import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, statfsSync, unlinkSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { LeaseError, type JobStore, type Lease } from "./jobs.ts";

const GIB = 1024 ** 3;
/** Ranged follow-up requests within one download call; a later run continues from the part file. */
const MAX_ROUNDS = 32;

/** PROPOSED default budget: min(20 GiB, 50% of free space), never leaving less than 2 GiB free. */
export function defaultMediaBudget(freeBytes: number): number {
  return Math.max(0, Math.min(20 * GIB, Math.floor(freeBytes / 2), freeBytes - 2 * GIB));
}

export type DownloadState =
  "pending" | "downloading" | "paused_budget" | "paused_disk" | "complete" | "failed";

export type DownloadOutcome =
  | "complete"
  | "paused_budget"
  | "paused_disk"
  | "interrupted"
  | "failed"
  /** Another live lease holds this entry; nothing was fetched or written. */
  | "claimed"
  /** The retained lease expired or was taken over; this worker stopped writing. */
  | "lease_lost";
export type JobOutcome =
  "complete" | "paused" | "partial" | "cancelled" | "not_acquired" | "lease_lost";

export interface MediaDownload {
  id: number;
  sourceId: string;
  url: string;
  state: DownloadState;
  bytesReceived: number;
  totalBytes: number | null;
  etag: string | null;
  mimeType: string | null;
  mediaId: number | null;
  error: string | null;
}

export interface BlobInfo {
  contentHash: string;
  sizeBytes: number;
  refCount: number;
}

export interface StorageStatus {
  budgetBytes: number;
  usedBytes: number;
  mediaPaused: boolean;
  textWritesAllowed: boolean;
}

export interface MediaFetchInit {
  headers: Record<string, string>;
  /** Redirects are never followed here; a 3xx fails the entry. */
  redirect: "manual";
  signal: AbortSignal;
}

/**
 * The network boundary. Required: there is no default to the global fetch. Production callers
 * inject the guarded fetcher (M1-11: private-network, loopback and redirect validation, ENR-03);
 * tests inject a loopback-only fetch for a local synthetic server.
 */
export type MediaFetch = (url: string, init: MediaFetchInit) => Promise<Response>;

export interface MediaFileHandle {
  write(chunk: Uint8Array): Promise<unknown>;
  close(): Promise<void>;
}

/** File operations, injectable so tests can simulate ENOSPC at each step. */
export interface MediaFs {
  open(path: string, flags: "a" | "w"): Promise<MediaFileHandle>;
  mkdir(path: string, options: { recursive: true }): Promise<unknown>;
  rename(from: string, to: string): Promise<void>;
  write(handle: MediaFileHandle, chunk: Uint8Array): Promise<unknown>;
}

export interface MediaStoreOptions {
  /** Directory that holds `blobs/` and `tmp/`. */
  root: string;
  budgetBytes: number;
  /** Free space that must remain on the volume; below it all writes pause. */
  minFreeBytes: number;
  fetch: MediaFetch;
  freeBytes?: () => number;
  /** Epoch-ms clock used for every lease call; it must advance. Defaults to Date.now. */
  now?: () => number;
  leaseTtlMs?: number;
  fs?: Partial<MediaFs>;
}

/** The lease returned by `JobStore.acquire`, retained for this attempt. Never rebuilt from get(). */
export interface LeaseContext {
  jobs: JobStore;
  jobId: string;
  lease: Lease;
}

interface Run extends LeaseContext {
  renewedAt: number;
}

/**
 * One execution attempt on one entry. `token` is the entry's exclusive claim while the attempt
 * runs; `part` is a file only this attempt ever opens, so a stale attempt's late async I/O can
 * reach nothing but its own file.
 */
interface Attempt {
  run: Run;
  id: number;
  token: string;
  partName: string;
  part: string;
  /** Whether the entry now records `partName` as its part file. */
  adopted: boolean;
}

interface Claim {
  at: Attempt;
  /** The part file holding the previous attempt's progress, if any. */
  prev: string | null;
  prevBytes: number;
  /** The previous attempt released its claim, so all of its file I/O had finished. */
  prevSealed: boolean;
}

interface DownloadRow {
  id: number;
  source_id: string;
  url: string;
  state: DownloadState;
  bytes_received: number;
  total_bytes: number | null;
  etag: string | null;
  mime_type: string | null;
  media_id: number | null;
  error: string | null;
  claim_job_id: string | null;
  claim_generation: number | null;
  claim_token: string | null;
  part_file: string | null;
}

const toDownload = (r: DownloadRow): MediaDownload => ({
  id: r.id,
  sourceId: r.source_id,
  url: r.url,
  state: r.state,
  bytesReceived: r.bytes_received,
  totalBytes: r.total_bytes,
  etag: r.etag,
  mimeType: r.mime_type,
  mediaId: r.media_id,
  error: r.error,
});

const isNoSpace = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOSPC";

const isStrong = (etag: string | null): etag is string => !!etag && !etag.startsWith("W/");

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** A claim is live while its job is running under the same, unexpired lease generation. */
const LIVE_CLAIM = `EXISTS (SELECT 1 FROM job j WHERE j.id = md.claim_job_id AND j.state = 'running'
  AND j.lease_expires_at > @now AND j.lease_generation = md.claim_generation)`;

const RESUMABLE = "('pending', 'downloading', 'paused_budget', 'paused_disk')";

class Stop extends Error {
  readonly outcome: "paused_budget" | "paused_disk";
  constructor(outcome: "paused_budget" | "paused_disk") {
    super(outcome);
    this.outcome = outcome;
  }
}

/**
 * Content-addressed media blobs with resumable downloads, a media budget, and disk-safety pauses
 * (MED-01, MED-04, Q28). Nothing is ever evicted: at the budget new media pauses and text continues
 * while disk safety permits. Removing unreferenced blobs belongs to the later purge layer.
 *
 * Every download runs under a retained job lease. Each execution attempt claims its entry with
 * (job, generation) and an exclusive token in a lease-checked transaction, and writes only to its
 * own part file, so late async I/O from a stale attempt can reach nothing another attempt or a
 * published blob uses. Every chunk is reserved and re-fenced before it is written, and the
 * blob/media rows commit through `JobStore.withLease`; a lost lease or claim stops writing at once.
 */
export class MediaStore {
  private budget: number;
  private diskFull = false;
  private readonly db: Database.Database;
  private readonly opts: MediaStoreOptions;
  private readonly freeBytes: () => number;
  private readonly doFetch: MediaFetch;
  private readonly now: () => number;
  private readonly ttl: number;
  private readonly fs: MediaFs;

  constructor(db: Database.Database, opts: MediaStoreOptions) {
    if (typeof opts.fetch !== "function") {
      throw new TypeError("MediaStore requires an injected fetch boundary (opts.fetch)");
    }
    this.db = db;
    this.opts = opts;
    this.budget = opts.budgetBytes;
    mkdirSync(join(opts.root, "blobs"), { recursive: true });
    mkdirSync(join(opts.root, "tmp"), { recursive: true });
    this.freeBytes =
      opts.freeBytes ??
      (() => {
        const s = statfsSync(opts.root);
        return Number(s.bavail) * Number(s.bsize);
      });
    this.doFetch = opts.fetch;
    this.now = opts.now ?? Date.now;
    this.ttl = opts.leaseTtlMs ?? 60_000;
    this.fs = {
      open: (p, f) => fsp.open(p, f),
      mkdir: (p, o) => fsp.mkdir(p, o),
      rename: (a, b) => fsp.rename(a, b),
      write: (h, c) => h.write(c),
      ...opts.fs,
    };
  }

  setBudget(bytes: number): void {
    this.budget = bytes;
  }

  enqueue(sourceId: string, url: string): MediaDownload {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("invalid media url");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("media url must be http or https");
    }
    if (parsed.username || parsed.password) {
      throw new Error("media url must not contain credentials");
    }
    this.db
      .prepare("INSERT OR IGNORE INTO media_download (source_id, url) VALUES (?, ?)")
      .run(sourceId, url);
    return toDownload(
      this.db
        .prepare("SELECT * FROM media_download WHERE source_id = ? AND url = ?")
        .get(sourceId, url) as DownloadRow,
    );
  }

  getDownload(id: number): MediaDownload {
    return toDownload(this.row(id));
  }

  blob(hash: string): BlobInfo | undefined {
    const r = this.db.prepare("SELECT * FROM blob WHERE content_hash = ?").get(hash) as
      { content_hash: string; size_bytes: number; ref_count: number } | undefined;
    return r && { contentHash: r.content_hash, sizeBytes: r.size_bytes, refCount: r.ref_count };
  }

  /** Drop one reference. The blob stays on disk; the purge layer decides about unreferenced blobs. */
  release(hash: string): void {
    const r = this.db
      .prepare("UPDATE blob SET ref_count = ref_count - 1 WHERE content_hash = ? AND ref_count > 0")
      .run(hash);
    if (r.changes === 0) throw new Error(`no reference to release for ${hash}`);
  }

  unreferenced(): string[] {
    return (
      this.db
        .prepare("SELECT content_hash FROM blob WHERE ref_count = 0 ORDER BY content_hash")
        .all() as { content_hash: string }[]
    ).map((r) => r.content_hash);
  }

  /** Committed blobs plus bytes held or reserved by partial downloads. */
  usedBytes(): number {
    const { n: blobs } = this.db
      .prepare("SELECT COALESCE(SUM(size_bytes), 0) n FROM blob")
      .get() as { n: number };
    const { n: parts } = this.db
      .prepare(
        "SELECT COALESCE(SUM(bytes_received), 0) n FROM media_download WHERE state <> 'complete'",
      )
      .get() as { n: number };
    return blobs + parts;
  }

  recheckDisk(): void {
    if (this.freeBytes() >= this.opts.minFreeBytes) this.diskFull = false;
  }

  private diskOk(extra = 0): boolean {
    return !this.diskFull && this.freeBytes() - extra >= this.opts.minFreeBytes;
  }

  /** Text capture may continue only while the volume is safe; media also stops at the budget. */
  status(): StorageStatus {
    const used = this.usedBytes();
    const textWritesAllowed = this.diskOk();
    const { n: waiting } = this.db
      .prepare(
        "SELECT COUNT(*) n FROM media_download WHERE state IN ('paused_budget', 'paused_disk')",
      )
      .get() as { n: number };
    return {
      budgetBytes: this.budget,
      usedBytes: used,
      mediaPaused: !textWritesAllowed || used >= this.budget || waiting > 0,
      textWritesAllowed,
    };
  }

  /**
   * Download one entry under the caller's retained lease, resuming from the partial file.
   * Throws LeaseError before any network or file work if the lease is not live; a lease lost
   * mid-transfer returns "lease_lost" and stops writing without committing.
   */
  async download(id: number, ctx: LeaseContext): Promise<DownloadOutcome> {
    const run: Run = { ...ctx, renewedAt: Number.NEGATIVE_INFINITY };
    // A stale or forged token throws here, before any network or file work.
    const claim = this.fenced(run, () => this.claimRow(run, this.row(id)));
    if (typeof claim === "string") return claim;
    return this.downloadIn(claim);
  }

  /** Run claimable downloads under a job lease. Pauses the job on budget or disk pressure. */
  async runJob(jobs: JobStore, jobId: string, owner: string): Promise<JobOutcome> {
    const start = this.now();
    // Retain the token minted by this acquisition; every later call is fenced by it.
    const lease = jobs.acquire(jobId, owner, start, this.ttl);
    if (!lease) return "not_acquired";
    const run: Run = { jobs, jobId, lease, renewedAt: start };
    const attempted: number[] = [];
    let done = 0;
    let interrupted = 0;
    let failed = 0;
    let deferred = 0;
    try {
      for (;;) {
        const claim = this.fenced(run, () => this.claimNext(run, attempted));
        if (claim === null) break;
        const id = claim.at.id;
        attempted.push(id);
        const outcome = await this.downloadIn(claim);
        if (outcome === "lease_lost") return "lease_lost";
        if (outcome === "paused_budget" || outcome === "paused_disk") {
          this.renewIfDue(run);
          jobs.checkpoint(jobId, lease, this.now(), { progress: `${done}/${attempted.length}` });
          jobs.transition(
            jobId,
            lease,
            this.now(),
            "paused",
            outcome === "paused_budget" ? "media budget reached" : "disk space low",
          );
          return "paused";
        }
        if (outcome === "complete") done++;
        else if (outcome === "failed") failed++;
        else if (outcome === "claimed") deferred++;
        else interrupted++;
        this.renewIfDue(run);
        const cancelRequested = jobs.checkpoint(jobId, lease, this.now(), {
          cursor: String(id),
          progress: `${done}/${attempted.length}`,
        });
        if (cancelRequested) {
          jobs.transition(jobId, lease, this.now(), "cancelled", "cancelled by user");
          return "cancelled";
        }
      }
      const reasons = [
        failed && `${failed} download(s) failed`,
        interrupted && `${interrupted} download(s) interrupted`,
        deferred && `${deferred} download(s) held by another job`,
      ].filter(Boolean);
      this.renewIfDue(run);
      if (reasons.length > 0) {
        jobs.transition(jobId, lease, this.now(), "partial", reasons.join("; "));
        return "partial";
      }
      jobs.transition(jobId, lease, this.now(), "complete");
      return "complete";
    } catch (e) {
      if (e instanceof LeaseError) return "lease_lost";
      throw e;
    }
  }

  private row(id: number): DownloadRow {
    const row = this.db.prepare("SELECT * FROM media_download WHERE id = ?").get(id) as
      DownloadRow | undefined;
    if (!row) throw new Error(`unknown media download ${id}`);
    return row;
  }

  private blobPath(hash: string): string {
    return `blobs/${hash.slice(0, 2)}/${hash}`;
  }

  private tmpPath(name: string): string {
    if (!/^[0-9]+(\.[0-9a-f-]{36})?\.part$/.test(name)) throw new RangeError("invalid part file");
    return join(this.opts.root, "tmp", name);
  }

  /** Renew the retained lease once a third of the TTL has passed. Throws LeaseError if lost. */
  private renewIfDue(run: Run): void {
    const now = this.now();
    if (now - run.renewedAt >= this.ttl / 3) {
      run.jobs.renew(run.jobId, run.lease, now, this.ttl);
      run.renewedAt = now;
    }
  }

  /** Run `fn` in one transaction with the retained lease validated (CAP-03 fencing). */
  private fenced<T>(run: Run, fn: () => T): T {
    this.renewIfDue(run);
    return run.jobs.withLease(run.jobId, run.lease, this.now(), () => fn());
  }

  /** `fenced`, and this attempt still holds the entry's exclusive claim token. */
  private owned<T>(at: Attempt, fn: () => T): T {
    return this.fenced(at.run, () => {
      if (this.row(at.id).claim_token !== at.token) throw new LeaseError("media claim lost");
      return fn();
    });
  }

  /** Atomically claim the next resumable entry, or a failure this job owns, for this lease. */
  private claimNext(run: Run, attempted: number[]): Claim | null {
    const row = this.db
      .prepare(
        `SELECT * FROM media_download md
         WHERE id NOT IN (SELECT value FROM json_each(@attempted))
           AND NOT (claim_token IS NOT NULL AND ${LIVE_CLAIM})
           AND ((state IN ${RESUMABLE} AND (claim_job_id IS NULL OR claim_job_id = @job OR NOT ${LIVE_CLAIM}))
             OR (state = 'failed' AND claim_job_id = @job))
         ORDER BY id LIMIT 1`,
      )
      .get({ attempted: JSON.stringify(attempted), job: run.jobId, now: this.now() }) as
      DownloadRow | undefined;
    if (!row) return null;
    const claim = this.claimRow(run, row);
    if (typeof claim === "string") throw new Error(`media download ${row.id} not claimable`);
    return claim;
  }

  /**
   * Claim one entry for a new execution attempt (inside a fenced transaction). Every attempt gets
   * a fresh token and its own part file; a second attempt is refused while any live attempt runs,
   * including one under this same retained lease.
   */
  private claimRow(run: Run, row: DownloadRow): Claim | "complete" | "claimed" {
    if (row.state === "complete") return "complete";
    if (row.claim_job_id !== null) {
      const sameLease =
        row.claim_job_id === run.jobId && row.claim_generation === run.lease.generation;
      const live = this.db
        .prepare(`SELECT ${LIVE_CLAIM} live FROM media_download md WHERE md.id = @id`)
        .get({ id: row.id, now: this.now() }) as { live: number };
      if (live.live && (!sameLease || row.claim_token !== null)) return "claimed";
    }
    const token = randomUUID();
    this.db
      .prepare(
        "UPDATE media_download SET claim_job_id = ?, claim_generation = ?, claim_token = ? WHERE id = ?",
      )
      .run(run.jobId, run.lease.generation, token, row.id);
    // Without a recorded part file, a partial from an earlier layout is `<id>.part`.
    const legacy = row.part_file === null && row.bytes_received > 0;
    return {
      at: {
        run,
        id: row.id,
        token,
        partName: `${row.id}.${token}.part`,
        part: this.tmpPath(`${row.id}.${token}.part`),
        adopted: false,
      },
      prev: legacy ? `${row.id}.part` : row.part_file,
      prevBytes: row.bytes_received,
      // A released token means the previous attempt finished all of its file I/O.
      prevSealed: !legacy && row.claim_token === null,
    };
  }

  private async downloadIn(c: Claim): Promise<DownloadOutcome> {
    const at = c.at;
    try {
      const adopted = await this.adopt(c);
      if (adopted !== "ok") return adopted;
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const outcome = await this.attempt(at);
        if (outcome !== "more") return outcome;
      }
      return this.record(at, "pending", { error: "too many partial responses" });
    } catch (e) {
      if (e instanceof LeaseError) return "lease_lost";
      throw e;
    } finally {
      this.endAttempt(at);
    }
  }

  /**
   * Release this attempt's claim token (only its own) once all of its file I/O has settled. A part
   * file the entry no longer points at belongs to nobody else and is removed.
   */
  private endAttempt(at: Attempt): void {
    this.db
      .prepare("UPDATE media_download SET claim_token = NULL WHERE id = ? AND claim_token = ?")
      .run(at.id, at.token);
    const row = this.row(at.id);
    if (row.part_file !== at.partName) rmIfExists(at.part);
  }

  /**
   * Move the previous attempt's verified prefix into this attempt's own part file. A cleanly ended
   * attempt's file is renamed; otherwise its owner may still hold an open handle, so only the
   * recorded prefix is copied and the old path is unlinked: that handle can then only ever reach
   * an orphaned file, never this attempt's part or a published blob.
   */
  private async adopt(c: Claim): Promise<"ok" | DownloadOutcome> {
    const { at } = c;
    let size = 0;
    if (c.prev !== null) {
      const from = this.tmpPath(c.prev);
      try {
        if (c.prevSealed && c.prevBytes > 0) {
          await this.fs.rename(from, at.part);
          size = statSync(at.part).size;
          if (size !== c.prevBytes) size = 0; // recorded progress disagrees: start over
        } else if (!c.prevSealed) {
          const n = existsSync(from) ? Math.min(c.prevBytes, statSync(from).size) : 0;
          if (n > 0 && !this.diskOk(n)) return this.record(at, "paused_disk");
          if (n > 0) size = await this.copyPrefix(from, at.part, n);
          rmIfExists(from);
        }
      } catch (e) {
        rmIfExists(at.part);
        if (isNoSpace(e)) {
          this.diskFull = true;
          return this.record(at, "paused_disk");
        }
        if ((e as { code?: string }).code !== "ENOENT") {
          return this.record(at, "pending", { error: message(e) });
        }
        size = 0;
      }
      if (size === 0) rmIfExists(at.part);
    }
    at.adopted = true;
    this.owned(at, () =>
      this.db
        .prepare("UPDATE media_download SET part_file = ?, bytes_received = ? WHERE id = ?")
        .run(at.partName, size, at.id),
    );
    return "ok";
  }

  private async copyPrefix(from: string, to: string, n: number): Promise<number> {
    let copied = 0;
    const handle = await this.fs.open(to, "w");
    try {
      for await (const chunk of createReadStream(from, { start: 0, end: n - 1 })) {
        await this.writeAll(handle, chunk as Buffer);
        copied += (chunk as Buffer).length;
      }
    } finally {
      await handle.close();
    }
    return statSync(to).size === copied ? copied : 0;
  }

  /** Write all of `chunk`, honoring short writes; a write that makes no progress is an error. */
  private async writeAll(handle: MediaFileHandle, chunk: Uint8Array): Promise<void> {
    let off = 0;
    while (off < chunk.length) {
      const rest = off === 0 ? chunk : chunk.subarray(off);
      const r = (await this.fs.write(handle, rest)) as { bytesWritten?: unknown } | undefined;
      const n = typeof r?.bytesWritten === "number" ? r.bytesWritten : rest.length;
      if (!Number.isSafeInteger(n) || n <= 0 || n > rest.length) {
        throw new Error("file write made no progress");
      }
      off += n;
    }
  }

  /** Update the entry under the claim and return the outcome it implies. */
  private record(
    at: Attempt,
    state: "pending" | "paused_budget" | "paused_disk" | "failed",
    f: { error?: string | null; reset?: boolean } = {},
  ): DownloadOutcome {
    this.owned(at, () => {
      if (!at.adopted) {
        // The previous part file was not taken over; leave its recorded progress untouched.
        this.db
          .prepare("UPDATE media_download SET state = ?, error = ? WHERE id = ?")
          .run(state, f.error ?? null, at.id);
        return;
      }
      if (f.reset) rmIfExists(at.part); // this attempt's own file; nobody else ever opens it
      const received = existsSync(at.part) ? statSync(at.part).size : 0;
      this.db
        .prepare(
          `UPDATE media_download SET state = ?, bytes_received = ?, error = ?, part_file = ?,
           total_bytes = CASE WHEN ? THEN NULL ELSE total_bytes END,
           etag = CASE WHEN ? THEN NULL ELSE etag END WHERE id = ?`,
        )
        .run(
          state,
          received,
          f.error ?? null,
          at.partName,
          f.reset ? 1 : 0,
          f.reset ? 1 : 0,
          at.id,
        );
    });
    return state === "pending" ? "interrupted" : state;
  }

  private partSize(at: Attempt): number {
    return existsSync(at.part) ? statSync(at.part).size : 0;
  }

  /** One request. "more" means the response was valid but ended before the representation did. */
  private async attempt(at: Attempt): Promise<DownloadOutcome | "more"> {
    const { id } = at;
    const d = this.row(id);
    let have = this.partSize(at);
    if (!this.diskOk()) return this.record(at, "paused_disk");
    // A fully received part whose finalize was interrupted (e.g. ENOSPC on rename) is verified
    // and committed without fetching it again.
    if (have > 0 && have === d.total_bytes && isStrong(d.etag)) {
      return this.finalizeOrPause(at, have);
    }
    if (have > 0 && (!isStrong(d.etag) || (d.total_bytes !== null && have > d.total_bytes))) {
      this.owned(at, () => rmIfExists(at.part)); // no strong validator: resuming could mix versions
      have = 0;
    }
    const overBudget = (extra: number) =>
      this.owned(at, () => this.usedBytes() - this.row(id).bytes_received + extra > this.budget);
    if (have > 0 ? overBudget(have) : this.usedBytes() >= this.budget) {
      return this.record(at, "paused_budget");
    }

    const headers: Record<string, string> = {};
    if (have > 0) {
      headers["range"] = `bytes=${have}-`;
      headers["if-range"] = d.etag!;
    }
    const abort = new AbortController();
    try {
      let res: Response;
      try {
        res = await this.doFetch(d.url, { headers, redirect: "manual", signal: abort.signal });
      } catch (e) {
        return this.record(at, "pending", { error: message(e) });
      }
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        return this.record(at, "failed", { error: "redirect not followed" });
      }
      if (res.status === 416) return this.record(at, "pending", { reset: true });
      if (!res.ok) {
        const transient = res.status >= 500 || res.status === 429 || res.status === 408;
        return this.record(at, transient ? "pending" : "failed", {
          error: `http ${res.status}`,
        });
      }

      const lengthHeader = res.headers.get("content-length");
      const length = lengthHeader === null ? null : Number(lengthHeader);
      if (length !== null && (!Number.isSafeInteger(length) || length < 0)) {
        return this.record(at, "pending", { error: "invalid content-length", reset: true });
      }
      const etag = res.headers.get("etag");
      let total: number | null;
      let end: number | null; // exclusive end of this response's bytes in the representation
      if (res.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get("content-range") ?? "");
        const start = m ? Number(m[1]) : NaN;
        const last = m ? Number(m[2]) : NaN;
        const size = m && m[3] !== "*" ? Number(m[3]) : null;
        // The representation length known from this response or, for `bytes a-b/*`, saved earlier.
        const known = size ?? d.total_bytes;
        if (
          !m ||
          !Number.isSafeInteger(last) ||
          have === 0 ||
          start !== have ||
          last < start ||
          (known !== null && last >= known) ||
          (size !== null && d.total_bytes !== null && size !== d.total_bytes) ||
          (length !== null && length !== last - start + 1)
        ) {
          return this.record(at, "pending", { error: "invalid content-range", reset: true });
        }
        // The saved prefix and this range must be the same representation: a 206 must carry
        // the exact strong validator the prefix was saved under.
        if (etag !== d.etag) {
          return this.record(at, "pending", { error: "validator changed", reset: true });
        }
        total = size ?? d.total_bytes;
        end = last + 1;
      } else {
        have = 0; // the server ignored Range or If-Range failed: start over
        total = length;
        end = length;
      }
      const mime = res.headers.get("content-type");
      if (total !== null && overBudget(total)) {
        return this.record(at, "paused_budget", have === 0 ? { reset: true } : {});
      }
      this.owned(at, () => {
        if (res.status === 206) {
          this.db
            .prepare(
              "UPDATE media_download SET state = 'downloading', total_bytes = ?, error = NULL WHERE id = ?",
            )
            .run(total, id);
        } else {
          rmIfExists(at.part);
          this.db
            .prepare(
              `UPDATE media_download SET state = 'downloading', bytes_received = 0, total_bytes = ?,
               etag = ?, mime_type = COALESCE(?, mime_type), error = NULL WHERE id = ?`,
            )
            .run(total, etag, mime, id);
        }
      });

      // Bytes this attempt has durably written to its own part file.
      let written = have;
      let overflow = false;
      let failure: unknown = null;
      try {
        const handle = await this.fs.open(at.part, have > 0 ? "a" : "w");
        try {
          const reader = res.body?.getReader();
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            if (end !== null && written + value.length > end) {
              overflow = true;
              break;
            }
            // Reserve the chunk against the shared budget under the live claim, then write it.
            this.owned(at, () => {
              const others = this.usedBytes() - this.row(id).bytes_received;
              if (others + written + value.length > this.budget) throw new Stop("paused_budget");
              if (!this.diskOk(value.length)) throw new Stop("paused_disk");
              this.db
                .prepare("UPDATE media_download SET bytes_received = ? WHERE id = ?")
                .run(written + value.length, id);
            });
            await this.writeAll(handle, value);
            written += value.length;
          }
        } finally {
          await handle.close();
        }
      } catch (e) {
        failure = e;
      }
      if (failure instanceof LeaseError) throw failure;
      // The file must hold exactly the bytes written; anything else cannot be resumed or trusted.
      const intact = this.partSize(at) === written;
      if (failure instanceof Stop) return this.record(at, failure.outcome, { reset: !intact });
      if (failure !== null) {
        if (isNoSpace(failure)) {
          this.diskFull = true;
          return this.record(at, "paused_disk", { reset: !intact });
        }
        return this.record(at, "pending", { error: message(failure), reset: !intact });
      }
      if (!intact) return this.record(at, "pending", { error: "short file write", reset: true });
      if (overflow) {
        return this.record(at, "pending", {
          error: "response longer than declared",
          reset: true,
        });
      }
      if (end !== null && written < end) {
        return this.record(at, "pending", { error: "connection closed early" });
      }
      // A partial response whose representation length is unknown proves nothing about the end:
      // ask for more rather than complete.
      if ((res.status === 206 && total === null) || (total !== null && written < total)) {
        this.owned(at, () =>
          this.db
            .prepare("UPDATE media_download SET bytes_received = ? WHERE id = ?")
            .run(written, id),
        );
        return "more";
      }
      return this.finalizeOrPause(at, written);
    } finally {
      abort.abort(); // cancel any unread body on every exit path
    }
  }

  private async finalizeOrPause(at: Attempt, size: number): Promise<DownloadOutcome> {
    try {
      return await this.finalize(at, size);
    } catch (e) {
      if (e instanceof LeaseError) throw e;
      if (isNoSpace(e)) {
        this.diskFull = true;
        return this.record(at, "paused_disk");
      }
      return this.record(at, "pending", { error: message(e) });
    }
  }

  private async finalize(at: Attempt, size: number): Promise<DownloadOutcome> {
    const { id } = at;
    // This attempt's own, closed part file: no other attempt ever opens it.
    const got = await hashFile(at.part);
    if (got.size !== size) {
      return this.record(at, "pending", { error: "part file changed", reset: true });
    }
    const digest = got.digest;
    const rel = this.blobPath(digest);
    const dest = join(this.opts.root, ...rel.split("/"));
    // Trust an existing blob only after verifying it; a corrupt one is replaced (atomically, by
    // rename) with these verified bytes.
    let valid = false;
    if (existsSync(dest)) {
      const existing = await hashFile(dest);
      valid = existing.digest === digest && existing.size === size;
    }
    if (valid) {
      this.owned(at, () => rmIfExists(at.part));
    } else {
      this.owned(at, () => undefined); // still the claim holder before touching the blob directory
      await this.fs.mkdir(join(this.opts.root, "blobs", digest.slice(0, 2)), { recursive: true });
      await this.fs.rename(at.part, dest);
    }
    this.owned(at, () => {
      const d = this.row(id);
      // A new blob row counts every media row that already names this content, including rows
      // that predate the media store (migration 5) and legacy duplicates.
      this.db
        .prepare(
          `INSERT INTO blob (content_hash, size_bytes, ref_count)
           VALUES (@h, @size, (SELECT COUNT(*) FROM media WHERE content_hash = @h))
           ON CONFLICT (content_hash) DO NOTHING`,
        )
        .run({ h: digest, size });
      const existing = this.db
        .prepare(
          "SELECT id FROM media WHERE source_id = ? AND content_hash = ? ORDER BY id LIMIT 1",
        )
        .get(d.source_id, digest) as { id: number } | undefined;
      let mediaId = existing?.id;
      if (mediaId === undefined) {
        mediaId = Number(
          this.db
            .prepare(
              "INSERT INTO media (source_id, content_hash, blob_path, mime_type) VALUES (?, ?, ?, ?)",
            )
            .run(d.source_id, digest, rel, d.mime_type).lastInsertRowid,
        );
        this.db
          .prepare("UPDATE blob SET ref_count = ref_count + 1 WHERE content_hash = ?")
          .run(digest);
      } else {
        // The linked row now points at the verified blob; other rows keep their recorded paths.
        this.db.prepare("UPDATE media SET blob_path = ? WHERE id = ?").run(rel, mediaId);
      }
      this.db
        .prepare(
          `UPDATE media_download SET state = 'complete', media_id = ?, bytes_received = ?,
           total_bytes = ?, error = NULL, part_file = NULL WHERE id = ?`,
        )
        .run(mediaId, size, size, id);
    });
    return "complete";
  }
}

const rmIfExists = (path: string): void => {
  try {
    unlinkSync(path);
  } catch (e) {
    if ((e as { code?: string }).code !== "ENOENT") throw e;
  }
};

async function hashFile(path: string): Promise<{ digest: string; size: number }> {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { digest: hash.digest("hex"), size };
}
