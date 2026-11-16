import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, statSync, statfsSync, unlinkSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
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
 * The network boundary. Required: there is no default to the global fetch. The media store applies
 * no SSRF screening of its own; the injected fetch is the only network guard. M1-11's
 * `guardedFetch` (`@citspark/core`) covers linked text pages and does not yet provide a
 * `MediaFetch` adapter (binary content types, streamed `Response`, Range), so no guarded media
 * fetcher exists yet and none is wired; callers must inject one that screens every address
 * (ENR-03). Tests inject a loopback-only fetch for a local synthetic server.
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
 * Every download runs under a retained job lease. Each entry is claimed by (job, generation) in a
 * lease-checked transaction, every chunk is reserved and re-fenced before it is written, and the
 * blob/media rows commit through `JobStore.withLease`; a lost lease stops writing at once.
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
    return this.downloadIn({ ...ctx, renewedAt: Number.NEGATIVE_INFINITY }, id);
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
        const id = this.fenced(run, () => this.claimNext(run, attempted));
        if (id === null) break;
        attempted.push(id);
        const outcome = await this.downloadIn(run, id);
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

  private partPath(id: number): string {
    if (!Number.isSafeInteger(id) || id < 1) throw new RangeError(`invalid download id ${id}`);
    return join(this.opts.root, "tmp", `${id}.part`);
  }

  private partSize(id: number): number {
    const part = this.partPath(id);
    return existsSync(part) ? statSync(part).size : 0;
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

  /** Atomically claim the next resumable entry, or a failure this job owns, for this lease. */
  private claimNext(run: Run, attempted: number[]): number | null {
    const row = this.db
      .prepare(
        `SELECT id FROM media_download md
         WHERE id NOT IN (SELECT value FROM json_each(@attempted))
           AND ((state IN ${RESUMABLE} AND (claim_job_id IS NULL OR claim_job_id = @job OR NOT ${LIVE_CLAIM}))
             OR (state = 'failed' AND claim_job_id = @job))
         ORDER BY id LIMIT 1`,
      )
      .get({ attempted: JSON.stringify(attempted), job: run.jobId, now: this.now() }) as
      { id: number } | undefined;
    if (!row) return null;
    this.setClaim(run, row.id);
    return row.id;
  }

  private setClaim(run: Run, id: number): void {
    this.db
      .prepare("UPDATE media_download SET claim_job_id = ?, claim_generation = ? WHERE id = ?")
      .run(run.jobId, run.lease.generation, id);
  }

  /** Claim one entry for this lease; "claimed" if another live lease holds it. */
  private claim(run: Run, id: number): "ok" | "complete" | "claimed" {
    return this.fenced(run, () => {
      const row = this.row(id);
      if (row.state === "complete") return "complete";
      const mine = row.claim_job_id === run.jobId && row.claim_generation === run.lease.generation;
      if (row.claim_job_id !== null && !mine) {
        const live = this.db
          .prepare(`SELECT ${LIVE_CLAIM} live FROM media_download md WHERE md.id = @id`)
          .get({ id, now: this.now() }) as { live: number };
        if (live.live) return "claimed";
      }
      this.setClaim(run, id);
      return "ok";
    });
  }

  private async downloadIn(run: Run, id: number): Promise<DownloadOutcome> {
    const claimed = this.claim(run, id); // a stale or forged token throws here, before any work
    if (claimed !== "ok") return claimed;
    try {
      for (let round = 0; round < MAX_ROUNDS; round++) {
        const outcome = await this.attempt(run, id);
        if (outcome !== "more") return outcome;
      }
      return this.record(run, id, "pending", { error: "too many partial responses" });
    } catch (e) {
      if (e instanceof LeaseError) return "lease_lost";
      throw e;
    }
  }

  /** Update the entry under the lease and return the outcome it implies. */
  private record(
    run: Run,
    id: number,
    state: "pending" | "paused_budget" | "paused_disk" | "failed",
    f: { error?: string | null; reset?: boolean } = {},
  ): DownloadOutcome {
    // The partial file is removed only while the lease is verified, so a worker that lost its
    // lease can never delete the new owner's progress.
    this.fenced(run, () => {
      const part = this.partPath(id);
      if (f.reset && existsSync(part)) unlinkSync(part);
      const received = this.partSize(id);
      this.db
        .prepare(
          `UPDATE media_download SET state = ?, bytes_received = ?, error = ?,
           total_bytes = CASE WHEN ? THEN NULL ELSE total_bytes END,
           etag = CASE WHEN ? THEN NULL ELSE etag END WHERE id = ?`,
        )
        .run(state, received, f.error ?? null, f.reset ? 1 : 0, f.reset ? 1 : 0, id);
    });
    return state === "pending" ? "interrupted" : state;
  }

  /** One request. "more" means the response was valid but ended before the representation did. */
  private async attempt(run: Run, id: number): Promise<DownloadOutcome | "more"> {
    const d = this.row(id);
    const part = this.partPath(id);
    let have = this.partSize(id);
    if (!this.diskOk()) return this.record(run, id, "paused_disk");
    // A fully received part whose finalize was interrupted (e.g. ENOSPC on rename) is verified
    // and committed without fetching it again.
    if (have > 0 && have === d.total_bytes && isStrong(d.etag)) {
      return this.finalizeOrPause(run, id, have);
    }
    if (have > 0 && (!isStrong(d.etag) || (d.total_bytes !== null && have > d.total_bytes))) {
      this.fenced(run, () => unlinkSync(part)); // no strong validator: resuming could mix versions
      have = 0;
    }
    const overBudget = (extra: number) =>
      this.fenced(run, () => this.usedBytes() - this.row(id).bytes_received + extra > this.budget);
    if (have > 0 ? overBudget(have) : this.usedBytes() >= this.budget) {
      return this.record(run, id, "paused_budget");
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
        return this.record(run, id, "pending", { error: message(e) });
      }
      if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
        return this.record(run, id, "failed", { error: "redirect not followed" });
      }
      if (res.status === 416) return this.record(run, id, "pending", { reset: true });
      if (!res.ok) {
        const transient = res.status >= 500 || res.status === 429 || res.status === 408;
        return this.record(run, id, transient ? "pending" : "failed", {
          error: `http ${res.status}`,
        });
      }

      const lengthHeader = res.headers.get("content-length");
      const length = lengthHeader === null ? null : Number(lengthHeader);
      if (length !== null && (!Number.isSafeInteger(length) || length < 0)) {
        return this.record(run, id, "pending", { error: "invalid content-length", reset: true });
      }
      let total: number | null;
      let end: number | null; // exclusive end of this response's bytes in the representation
      if (res.status === 206) {
        const m = /^bytes (\d+)-(\d+)\/(\d+|\*)$/.exec(res.headers.get("content-range") ?? "");
        const start = m ? Number(m[1]) : NaN;
        const last = m ? Number(m[2]) : NaN;
        const size = m && m[3] !== "*" ? Number(m[3]) : null;
        if (
          !m ||
          have === 0 ||
          start !== have ||
          last < start ||
          (size !== null && last >= size) ||
          (size !== null && d.total_bytes !== null && size !== d.total_bytes) ||
          (length !== null && length !== last - start + 1)
        ) {
          return this.record(run, id, "pending", { error: "invalid content-range", reset: true });
        }
        total = size ?? d.total_bytes;
        end = last + 1;
      } else {
        if (have > 0) have = 0; // the server ignored Range or If-Range failed: start over
        total = length;
        end = length;
      }
      const etag = res.headers.get("etag");
      const mime = res.headers.get("content-type");
      if (total !== null && overBudget(total)) {
        return this.record(run, id, "paused_budget", have === 0 ? { reset: true } : {});
      }
      this.fenced(run, () => {
        if (res.status === 206) {
          this.db
            .prepare(
              "UPDATE media_download SET state = 'downloading', total_bytes = ?, error = NULL WHERE id = ?",
            )
            .run(total, id);
        } else {
          this.db
            .prepare(
              `UPDATE media_download SET state = 'downloading', bytes_received = 0, total_bytes = ?,
               etag = ?, mime_type = COALESCE(?, mime_type), error = NULL WHERE id = ?`,
            )
            .run(total, etag, mime, id);
        }
      });

      let received = have;
      let overflow = false;
      try {
        const handle = await this.fs.open(part, have > 0 ? "a" : "w");
        try {
          const reader = res.body?.getReader();
          while (reader) {
            const { done, value } = await reader.read();
            if (done) break;
            if (end !== null && received + value.length > end) {
              overflow = true;
              break;
            }
            // Reserve the chunk against the shared budget under the live lease, then write it.
            this.fenced(run, () => {
              const others = this.usedBytes() - this.row(id).bytes_received;
              if (others + received + value.length > this.budget) throw new Stop("paused_budget");
              if (!this.diskOk(value.length)) throw new Stop("paused_disk");
              this.db
                .prepare("UPDATE media_download SET bytes_received = ? WHERE id = ?")
                .run(received + value.length, id);
            });
            await this.fs.write(handle, value);
            received += value.length;
          }
        } finally {
          await handle.close();
        }
      } catch (e) {
        if (e instanceof Stop) return this.record(run, id, e.outcome);
        if (e instanceof LeaseError) throw e;
        if (isNoSpace(e)) {
          this.diskFull = true;
          return this.record(run, id, "paused_disk");
        }
        return this.record(run, id, "pending", { error: message(e) });
      }
      received = this.partSize(id);
      if (overflow) {
        return this.record(run, id, "pending", {
          error: "response longer than declared",
          reset: true,
        });
      }
      if (end !== null && received < end) {
        return this.record(run, id, "pending", { error: "connection closed early" });
      }
      if (total !== null && received < total) {
        this.fenced(run, () =>
          this.db
            .prepare("UPDATE media_download SET bytes_received = ? WHERE id = ?")
            .run(received, id),
        );
        return "more";
      }
      return this.finalizeOrPause(run, id, received);
    } finally {
      abort.abort(); // cancel any unread body on every exit path
    }
  }

  private async finalizeOrPause(run: Run, id: number, size: number): Promise<DownloadOutcome> {
    try {
      return await this.finalize(run, id, size);
    } catch (e) {
      if (e instanceof LeaseError) throw e;
      if (isNoSpace(e)) {
        this.diskFull = true;
        return this.record(run, id, "paused_disk");
      }
      return this.record(run, id, "pending", { error: message(e) });
    }
  }

  private async finalize(run: Run, id: number, size: number): Promise<DownloadOutcome> {
    const part = this.partPath(id);
    const hash = createHash("sha256");
    await pipeline(createReadStream(part), hash);
    const digest = hash.digest("hex");
    const rel = this.blobPath(digest);
    const dest = join(this.opts.root, ...rel.split("/"));
    // Still the live lease before touching the blob directory. A lease lost after the rename leaves
    // an unrecorded, content-addressed blob that the next owner's identical download reuses.
    const exists = this.fenced(run, () => {
      if (!existsSync(dest)) return false;
      unlinkSync(part);
      return true;
    });
    if (!exists) {
      await this.fs.mkdir(join(this.opts.root, "blobs", digest.slice(0, 2)), { recursive: true });
      await this.fs.rename(part, dest);
    }
    this.fenced(run, () => {
      const d = this.row(id);
      this.db
        .prepare("INSERT OR IGNORE INTO blob (content_hash, size_bytes) VALUES (?, ?)")
        .run(digest, size);
      const existing = this.db
        .prepare("SELECT id FROM media WHERE source_id = ? AND content_hash = ?")
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
      }
      this.db
        .prepare(
          "UPDATE media_download SET state = 'complete', media_id = ?, bytes_received = ?, total_bytes = ?, error = NULL WHERE id = ?",
        )
        .run(mediaId, size, size, id);
    });
    return "complete";
  }
}
