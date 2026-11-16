import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  statfsSync,
  truncateSync,
  unlinkSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { JobStore } from "./jobs.ts";

const GIB = 1024 ** 3;

/** PROPOSED default budget: min(20 GiB, 50% of free space), never leaving less than 2 GiB free. */
export function defaultMediaBudget(freeBytes: number): number {
  return Math.max(0, Math.min(20 * GIB, Math.floor(freeBytes / 2), freeBytes - 2 * GIB));
}

export type DownloadState =
  "pending" | "downloading" | "paused_budget" | "paused_disk" | "complete" | "failed";

export type DownloadOutcome =
  "complete" | "paused_budget" | "paused_disk" | "interrupted" | "failed";
export type JobOutcome = "complete" | "paused" | "partial" | "cancelled" | "not_acquired";

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

export interface MediaStoreOptions {
  /** Directory that holds `blobs/` and `tmp/`. */
  root: string;
  budgetBytes: number;
  /** Free space that must remain on the volume; below it all writes pause. */
  minFreeBytes: number;
  freeBytes?: () => number;
  fetch?: typeof fetch;
  /** Test seam for the file write; real disk-full errors surface as ENOSPC. */
  writeChunk?: (
    handle: { write(b: Uint8Array): Promise<unknown> },
    chunk: Uint8Array,
  ) => Promise<unknown>;
  leaseTtlMs?: number;
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

/**
 * Content-addressed media blobs with resumable downloads, a media budget, and disk-safety pauses
 * (MED-01, MED-04, Q28). Nothing is ever evicted: at the budget new media pauses and text continues
 * while disk safety permits. Removing unreferenced blobs belongs to the later purge layer.
 */
export class MediaStore {
  private budget: number;
  private diskFull = false;
  private readonly freeBytes: () => number;
  private readonly doFetch: typeof fetch;

  private readonly db: Database.Database;
  private readonly opts: MediaStoreOptions;

  constructor(db: Database.Database, opts: MediaStoreOptions) {
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
    this.doFetch = opts.fetch ?? fetch;
  }

  setBudget(bytes: number): void {
    this.budget = bytes;
  }

  enqueue(sourceId: string, url: string): MediaDownload {
    if (!/^https?:\/\//i.test(url)) throw new Error("media url must be http or https");
    this.db
      .prepare("INSERT OR IGNORE INTO media_download (source_id, url) VALUES (?, ?)")
      .run(sourceId, url);
    const row = this.db
      .prepare("SELECT * FROM media_download WHERE source_id = ? AND url = ?")
      .get(sourceId, url) as DownloadRow;
    return toDownload(row);
  }

  getDownload(id: number): MediaDownload {
    const row = this.db.prepare("SELECT * FROM media_download WHERE id = ?").get(id) as
      DownloadRow | undefined;
    if (!row) throw new Error(`unknown media download ${id}`);
    return toDownload(row);
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
        .all() as {
        content_hash: string;
      }[]
    ).map((r) => r.content_hash);
  }

  /** Committed blobs plus bytes held in partial downloads. */
  usedBytes(): number {
    const blobs = this.db.prepare("SELECT COALESCE(SUM(size_bytes), 0) n FROM blob").get() as {
      n: number;
    };
    const parts = this.db
      .prepare(
        "SELECT COALESCE(SUM(bytes_received), 0) n FROM media_download WHERE state <> 'complete'",
      )
      .get() as { n: number };
    return blobs.n + parts.n;
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

  private blobPath(hash: string): string {
    return `blobs/${hash.slice(0, 2)}/${hash}`;
  }

  private partPath(id: number): string {
    return join(this.opts.root, "tmp", `${id}.part`);
  }

  private setState(id: number, state: DownloadState, fields: Partial<DownloadRow> = {}): void {
    this.db
      .prepare(
        `UPDATE media_download SET state = ?, bytes_received = COALESCE(?, bytes_received),
         total_bytes = COALESCE(?, total_bytes), etag = COALESCE(?, etag),
         mime_type = COALESCE(?, mime_type), error = ? WHERE id = ?`,
      )
      .run(
        state,
        fields.bytes_received ?? null,
        fields.total_bytes ?? null,
        fields.etag ?? null,
        fields.mime_type ?? null,
        fields.error ?? null,
        id,
      );
  }

  private resetPart(id: number): void {
    if (existsSync(this.partPath(id))) unlinkSync(this.partPath(id));
    this.db.prepare("UPDATE media_download SET bytes_received = 0 WHERE id = ?").run(id);
  }

  /** Download one entry, resuming from the partial file when present. */
  async download(id: number): Promise<DownloadOutcome> {
    const d = this.getDownload(id);
    if (d.state === "complete") return "complete";
    if (!this.diskOk()) return this.pause(id, "paused_disk");
    const part = this.partPath(id);
    let have = existsSync(part) ? statSync(part).size : 0;
    const othersBytes = this.usedBytes() - d.bytesReceived;
    if (othersBytes + have >= this.budget) return this.pause(id, "paused_budget");

    const headers: Record<string, string> = {};
    if (have > 0 && !(d.etag && !d.etag.startsWith("W/"))) {
      this.resetPart(id);
      have = 0;
    }
    if (have > 0) {
      headers["range"] = `bytes=${have}-`;
      if (d.etag) headers["if-range"] = d.etag;
    }
    let res: Response;
    try {
      res = await this.doFetch(d.url, { headers });
    } catch (e) {
      return this.interrupted(id, part, e);
    }
    if (res.status === 416) {
      this.resetPart(id);
      await res.body?.cancel();
      this.setState(id, "pending");
      return "interrupted";
    }
    if (!res.ok) {
      await res.body?.cancel();
      if (res.status >= 500 || res.status === 429) {
        this.setState(id, "pending", { error: `http ${res.status}` });
        return "interrupted";
      }
      this.setState(id, "failed", { error: `http ${res.status}` });
      return "failed";
    }
    const rangeStart = /^bytes (\d+)-/.exec(res.headers.get("content-range") ?? "")?.[1];
    if (res.status === 206 && Number(rangeStart) !== have) {
      await res.body?.cancel();
      this.resetPart(id);
      this.setState(id, "pending", { error: "unexpected content-range" });
      return "interrupted";
    }
    const resumed = res.status === 206;
    if (!resumed && have > 0) {
      truncateSync(part, 0);
      have = 0;
    }
    const length = Number(res.headers.get("content-length") ?? NaN);
    const total = Number.isFinite(length) ? have + length : null;
    const etag = res.headers.get("etag");
    const mime = res.headers.get("content-type");
    if (total !== null && othersBytes + total > this.budget) {
      await res.body?.cancel();
      return this.pause(id, "paused_budget", { bytes_received: have });
    }
    this.setState(id, "downloading", {
      bytes_received: have,
      ...(total !== null ? { total_bytes: total } : {}),
      ...(etag ? { etag } : {}),
      ...(mime ? { mime_type: mime } : {}),
    });

    const handle = await open(part, have > 0 ? "a" : "w");
    let received = have;
    let stop: DownloadOutcome | null = null;
    try {
      const reader = res.body?.getReader();
      while (reader) {
        const { done, value } = await reader.read();
        if (done) break;
        if (othersBytes + received + value.length > this.budget) {
          stop = "paused_budget";
          await reader.cancel();
          break;
        }
        if (!this.diskOk(value.length)) {
          stop = "paused_disk";
          await reader.cancel();
          break;
        }
        await (this.opts.writeChunk ?? ((h, c) => h.write(c)))(handle, value);
        received += value.length;
      }
    } catch (e) {
      await handle.close();
      received = existsSync(part) ? statSync(part).size : 0;
      if (isNoSpace(e)) {
        this.diskFull = true;
        return this.pause(id, "paused_disk", { bytes_received: received });
      }
      return this.interrupted(id, part, e);
    }
    await handle.close();
    received = statSync(part).size;
    if (stop === "paused_disk" || stop === "paused_budget") {
      return this.pause(id, stop, { bytes_received: received });
    }
    if (total !== null && received < total) {
      this.setState(id, "pending", { bytes_received: received });
      return "interrupted";
    }
    return this.finalize(id, part, received);
  }

  private pause(id: number, state: "paused_budget" | "paused_disk", f: Partial<DownloadRow> = {}) {
    this.setState(id, state, f);
    return state;
  }

  private interrupted(id: number, part: string, e: unknown): DownloadOutcome {
    const received = existsSync(part) ? statSync(part).size : 0;
    this.setState(id, "pending", {
      bytes_received: received,
      error: e instanceof Error ? e.message : String(e),
    });
    return "interrupted";
  }

  private async finalize(id: number, part: string, size: number): Promise<DownloadOutcome> {
    const hash = createHash("sha256");
    await pipeline(createReadStream(part), hash);
    const digest = hash.digest("hex");
    const rel = this.blobPath(digest);
    const dest = join(this.opts.root, ...rel.split("/"));
    if (!existsSync(dest)) {
      mkdirSync(join(this.opts.root, "blobs", digest.slice(0, 2)), { recursive: true });
      renameSync(part, dest);
    } else {
      unlinkSync(part);
    }
    this.db
      .transaction(() => {
        const d = this.getDownload(id);
        this.db
          .prepare("INSERT OR IGNORE INTO blob (content_hash, size_bytes) VALUES (?, ?)")
          .run(digest, size);
        const existing = this.db
          .prepare("SELECT id FROM media WHERE source_id = ? AND content_hash = ?")
          .get(d.sourceId, digest) as { id: number } | undefined;
        let mediaId = existing?.id;
        if (mediaId === undefined) {
          mediaId = Number(
            this.db
              .prepare(
                "INSERT INTO media (source_id, content_hash, blob_path, mime_type) VALUES (?, ?, ?, ?)",
              )
              .run(d.sourceId, digest, rel, d.mimeType).lastInsertRowid,
          );
          this.db
            .prepare("UPDATE blob SET ref_count = ref_count + 1 WHERE content_hash = ?")
            .run(digest);
        }
        this.db
          .prepare(
            "UPDATE media_download SET state = 'complete', media_id = ?, bytes_received = ?, error = NULL WHERE id = ?",
          )
          .run(mediaId, size, id);
      })
      .immediate();
    return "complete";
  }

  /** Run pending downloads under a job lease. Pauses the job on budget or disk pressure. */
  async runJob(jobs: JobStore, jobId: string, owner: string, nowMs: number): Promise<JobOutcome> {
    const ttl = this.opts.leaseTtlMs ?? 60_000;
    if (!jobs.acquire(jobId, owner, nowMs, ttl)) return "not_acquired";
    const ids = (
      this.db
        .prepare(
          "SELECT id FROM media_download WHERE state IN ('pending','downloading','paused_budget','paused_disk') ORDER BY id",
        )
        .all() as { id: number }[]
    ).map((r) => r.id);
    let interrupted = 0;
    let done = 0;
    for (const id of ids) {
      jobs.renew(jobId, owner, nowMs, ttl);
      const outcome = await this.download(id);
      if (outcome === "paused_budget" || outcome === "paused_disk") {
        jobs.checkpoint(jobId, owner, nowMs, { progress: `${done}/${ids.length}` });
        jobs.transition(
          jobId,
          owner,
          nowMs,
          "paused",
          outcome === "paused_budget" ? "media budget reached" : "disk space low",
        );
        return "paused";
      }
      if (outcome === "interrupted") interrupted++;
      else done++;
      const cancelRequested = jobs.checkpoint(jobId, owner, nowMs, {
        cursor: String(id),
        progress: `${done}/${ids.length}`,
      });
      if (cancelRequested) {
        jobs.transition(jobId, owner, nowMs, "cancelled", "cancelled by user");
        return "cancelled";
      }
    }
    if (interrupted > 0) {
      jobs.transition(jobId, owner, nowMs, "partial", `${interrupted} download(s) interrupted`);
      return "partial";
    }
    jobs.transition(jobId, owner, nowMs, "complete");
    return "complete";
  }
}
