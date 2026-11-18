import type Database from "better-sqlite3";
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

export class UnknownSourceError extends Error {}
export class NotTrashedError extends Error {}
export class PurgedSourceError extends Error {}
/** A live job lease holds one of the source's downloads; purge again after it ends or expires. */
export class PurgeBusyError extends Error {}

/** `unknown` is never captured; `trashed` and `purged` evidence must be reported unavailable (DAT-04). */
export type SourceStatus = "available" | "trashed" | "purged" | "unknown";

export interface TrashEntry {
  sourceId: string;
  trashedAt: string;
}

export interface PurgeResult {
  sourceId: string;
  /** Blobs whose last reference went away; their files are removed now or queued for retry. */
  blobsRemoved: string[];
  /** File removals for this source still queued after this call (see `retryPendingFiles`). */
  filesPending: number;
}

export interface EmptyTrashResult {
  purged: string[];
  /** Sources left in trash because a live job holds one of their downloads. */
  busy: string[];
  blobsRemoved: string[];
  /** File removals of every purged source still queued after this call, not only this call's. */
  filesPending: number;
}

export interface TrashStoreOptions {
  /** Media root that holds `blobs/` and `tmp/`, as given to `MediaStore`. */
  mediaRoot: string;
  /** File removal seam for tests; must treat a missing file as removed. Defaults to `rmSync(force)`. */
  removeFile?: (path: string) => void;
}

const HASH = /^[0-9a-f]{64}$/;
const SUPPRESSED_TRASH = "source_trashed";
const SUPPRESSED_PURGE = "source_purged";
const RESUMABLE = "('pending', 'downloading', 'paused_budget', 'paused_disk')";
/** Same rule as the media store: the claiming job is running under the same, unexpired lease. */
const LIVE_CLAIM = `EXISTS (SELECT 1 FROM job j WHERE j.id = md.claim_job_id AND j.state = 'running'
  AND j.lease_expires_at > @now AND j.lease_generation = md.claim_generation)`;
/**
 * An execution attempt that has not ended (it still holds its exclusive claim token) under a live
 * lease. Only such an attempt can still commit blob or media rows: the media store fences every
 * commit by both the lease and the token, so an attempt whose lease expired, or whose token was
 * cleared here, can at most leave files that nothing references.
 */
const LIVE_ATTEMPT = `(md.claim_token IS NOT NULL AND ${LIVE_CLAIM})`;
/** Part files the media store writes under `tmp/`: `<id>.part` (earlier layout) or `<id>.<token>.part`. */
const PART = /^([0-9]+)(\.[0-9a-f-]{36})?\.part$/;

/**
 * Recoverable trash and explicit purge (DAT-03, DAT-04, Q50, SYN-04, Q51). Trash marks the source,
 * which hides it from the `active_*` views, suppresses recapture (capture pages, linked enrichment
 * and media downloads) and unlinks its vault-note binding. Purge is explicit: it removes
 * source-derived rows, partial downloads and unshared blobs (by reference count, validated against
 * the remaining media rows) and leaves a tombstone so recapture stays suppressed and retained
 * citations report unavailable. File removals are queued in the purge transaction and retried until
 * done. Vault files and backups are separate copies and are never touched (DAT-04). Time is epoch ms.
 */
export class TrashStore {
  private readonly db: Database.Database;
  private readonly opts: TrashStoreOptions;
  private readonly removeFile: (path: string) => void;

  constructor(db: Database.Database, opts: TrashStoreOptions) {
    this.db = db;
    this.opts = opts;
    this.removeFile = opts.removeFile ?? ((p) => rmSync(p, { force: true }));
  }

  trash(sourceId: string, nowMs: number): void {
    this.db
      .transaction(() => {
        const row = this.row(sourceId);
        if (row.purged_at !== null || row.trashed_at !== null) return;
        const db = this.db;
        db.prepare("UPDATE source SET trashed_at = ? WHERE id = ?").run(
          new Date(nowMs).toISOString(),
          sourceId,
        );
        // SYN-04: the vault note is kept but unlinked; re-creation and re-import stay suppressed
        // until the binding is explicitly restored. A stronger suppression is never downgraded.
        db.prepare(
          `UPDATE sync_binding SET state = 'unlinked',
             suppression = CASE suppression WHEN 'none' THEN 'unlinked' ELSE suppression END
           WHERE source_id = ?`,
        ).run(sourceId);
        // Waiting downloads stop; one a running attempt is transferring finishes into trash. A
        // cleanly ended attempt (token released) keeps its part file for a resume after restore.
        // An attempt that never ended (crashed, or its lease expired) may still hold an open
        // handle on its part file, so its progress cannot be taken over by rename: the file is
        // queued for removal and the entry restarts from zero.
        const stop = { id: sourceId, now: nowMs };
        const queue = db.prepare(
          "INSERT OR IGNORE INTO purge_file (path, source_id, kind) VALUES (?, ?, 'partial')",
        );
        const unended = db
          .prepare(
            `SELECT part_file FROM media_download AS md WHERE source_id = @id
               AND claim_token IS NOT NULL AND part_file IS NOT NULL AND NOT ${LIVE_ATTEMPT}`,
          )
          .all(stop) as { part_file: string }[];
        for (const r of unended) {
          if (PART.test(r.part_file)) queue.run(`tmp/${r.part_file}`, sourceId);
        }
        db.prepare(
          `UPDATE media_download AS md SET part_file = NULL, bytes_received = 0, total_bytes = NULL,
             etag = NULL
           WHERE source_id = @id AND claim_token IS NOT NULL AND state <> 'complete'
             AND NOT ${LIVE_ATTEMPT}`,
        ).run(stop);
        db.prepare(
          `UPDATE media_download AS md SET state = 'failed', error = @reason
           WHERE source_id = @id AND state IN ${RESUMABLE} AND NOT ${LIVE_ATTEMPT}`,
        ).run({ ...stop, reason: SUPPRESSED_TRASH });
        // No job may claim the entry again while the source is in trash, including a job retrying
        // its own failures.
        db.prepare(
          `UPDATE media_download AS md SET claim_job_id = NULL, claim_generation = NULL,
             claim_token = NULL
           WHERE source_id = @id AND claim_job_id IS NOT NULL AND NOT ${LIVE_ATTEMPT}`,
        ).run(stop);
      })
      .immediate();
    this.retryPendingFiles(nowMs);
  }

  /** Restore a trashed source. Its vault binding stays unlinked until restored explicitly (SYN-04). */
  restore(sourceId: string): void {
    this.db
      .transaction(() => {
        const row = this.row(sourceId);
        if (row.purged_at !== null) {
          throw new PurgedSourceError(`source ${sourceId} was purged and cannot be restored`);
        }
        this.db.prepare("UPDATE source SET trashed_at = NULL WHERE id = ?").run(sourceId);
        this.db
          .prepare(
            "UPDATE media_download SET state = 'pending', error = NULL WHERE source_id = ? AND state = 'failed' AND error = ?",
          )
          .run(sourceId, SUPPRESSED_TRASH);
      })
      .immediate();
  }

  list(): TrashEntry[] {
    return (
      this.db
        .prepare(
          "SELECT id, trashed_at FROM source WHERE trashed_at IS NOT NULL AND purged_at IS NULL ORDER BY trashed_at, id",
        )
        .all() as { id: string; trashed_at: string }[]
    ).map((r) => ({ sourceId: r.id, trashedAt: r.trashed_at }));
  }

  status(sourceId: string): SourceStatus {
    const r = this.db
      .prepare("SELECT trashed_at, purged_at FROM source WHERE id = ?")
      .get(sourceId) as { trashed_at: string | null; purged_at: string | null } | undefined;
    if (!r) return "unknown";
    if (r.purged_at !== null) return "purged";
    return r.trashed_at !== null ? "trashed" : "available";
  }

  /**
   * Permanently remove a trashed source's derived data. Idempotent for an already purged source,
   * which only retries queued file removals. Throws PurgeBusyError, changing nothing, while one of
   * the source's downloads has a running attempt (an unreleased claim token under a live lease).
   */
  purge(sourceId: string, nowMs: number): PurgeResult {
    const row = this.row(sourceId);
    if (row.purged_at === null && row.trashed_at === null) {
      throw new NotTrashedError(`source ${sourceId} is not in trash`);
    }
    const removed =
      row.purged_at !== null
        ? []
        : this.db.transaction(() => this.purgeRows(sourceId, nowMs)).immediate();
    this.retryPendingFiles(nowMs);
    const { n } = this.db
      .prepare("SELECT COUNT(*) n FROM purge_file WHERE source_id = ?")
      .get(sourceId) as { n: number };
    return { sourceId, blobsRemoved: removed, filesPending: n };
  }

  /**
   * Explicitly purge everything currently in trash. Busy sources stay in trash and are reported.
   * Always retries every queued file removal, also of sources purged earlier, even when the trash
   * is empty.
   */
  emptyTrash(nowMs: number): EmptyTrashResult {
    const purged: string[] = [];
    const busy: string[] = [];
    const blobs = new Set<string>();
    for (const e of this.list()) {
      try {
        const r = this.purge(e.sourceId, nowMs);
        purged.push(e.sourceId);
        r.blobsRemoved.forEach((h) => blobs.add(h));
      } catch (err) {
        if (!(err instanceof PurgeBusyError)) throw err;
        busy.push(e.sourceId);
      }
    }
    this.retryPendingFiles(nowMs);
    const { n: filesPending } = this.db.prepare("SELECT COUNT(*) n FROM purge_file").get() as {
      n: number;
    };
    return { purged, busy, blobsRemoved: [...blobs].sort(), filesPending };
  }

  /**
   * Retry queued file removals (after a failed unlink, or a crash after the purge committed) and
   * remove files a purge left unreferenced. The database is authoritative: a queued blob that a
   * `blob` row or any `media` row (including rows that predate the blob table) names again is kept
   * and dequeued. Blob files are only removed while no media download attempt is running under a
   * live lease, because such an attempt may have just published or verified those bytes and not
   * yet committed its rows; they stay queued until it ends.
   *
   * In-flight async file work of a worker whose lease expired cannot be stopped from here. Its
   * late open or write reaches only its own attempt-named part file, which the attempt removes
   * when it ends; a late rename into `blobs/` leaves an unreferenced file that the sweep in this
   * method removes on its next run (every trash, purge and `emptyTrash` runs it; callers should
   * also run it at startup). `nowMs` decides which leases are live.
   */
  retryPendingFiles(nowMs: number = Date.now()): { removed: number; pending: number } {
    return this.db.transaction(() => this.retryIn(nowMs)).immediate();
  }

  private retryIn(nowMs: number): { removed: number; pending: number } {
    const db = this.db;
    const busy =
      db
        .prepare(`SELECT 1 FROM media_download md WHERE ${LIVE_ATTEMPT} LIMIT 1`)
        .get({ now: nowMs }) !== undefined;
    const rows = db.prepare("SELECT path, kind FROM purge_file ORDER BY path").all() as {
      path: string;
      kind: "blob" | "partial";
    }[];
    const done = db.prepare("DELETE FROM purge_file WHERE path = ?");
    let removed = 0;
    let pending = 0;
    const remove = (rel: string): boolean => {
      try {
        this.removeFile(join(this.opts.mediaRoot, ...rel.split("/")));
        return true;
      } catch {
        return false;
      }
    };
    for (const r of rows) {
      if (r.kind === "blob") {
        if (this.referenced(r.path)) {
          done.run(r.path);
          continue;
        }
        if (busy) {
          pending++;
          continue;
        }
      }
      if (remove(r.path)) {
        done.run(r.path);
        removed++;
      } else {
        pending++;
      }
    }
    for (const rel of this.orphans(busy)) {
      if (remove(rel)) removed++;
    }
    return { removed, pending };
  }

  /** Whether any `blob` or `media` row names the blob at `blobs/<xx>/<hash>`. */
  private referenced(path: string): boolean {
    const hash = path.split("/").pop() ?? "";
    return (
      this.db
        .prepare(
          `SELECT 1 WHERE EXISTS (SELECT 1 FROM blob WHERE content_hash = @hash)
             OR EXISTS (SELECT 1 FROM media WHERE content_hash = @hash OR blob_path = @path)`,
        )
        .get({ hash, path }) !== undefined
    );
  }

  /**
   * Files no row references any more: part files of purged sources' downloads, and (only while
   * no attempt is live) content-addressed blob files with no `blob` or `media` row. Files with
   * other names are never touched.
   */
  private orphans(busy: boolean): string[] {
    const out: string[] = [];
    const list = (rel: string): string[] => {
      try {
        return readdirSync(join(this.opts.mediaRoot, ...rel.split("/")));
      } catch {
        return [];
      }
    };
    const purgedDownload = this.db.prepare(
      `SELECT 1 FROM media_download md JOIN source s ON s.id = md.source_id
       WHERE md.id = ? AND s.purged_at IS NOT NULL`,
    );
    for (const name of list("tmp")) {
      const m = PART.exec(name);
      if (m && purgedDownload.get(Number(m[1])) !== undefined) out.push(`tmp/${name}`);
    }
    if (busy) return out;
    for (const shard of list("blobs")) {
      if (!/^[0-9a-f]{2}$/.test(shard)) continue;
      for (const name of list(`blobs/${shard}`)) {
        const rel = `blobs/${shard}/${name}`;
        if (HASH.test(name) && name.startsWith(shard) && !this.referenced(rel)) out.push(rel);
      }
    }
    return out;
  }

  /** Every row change of one purge; runs inside an IMMEDIATE transaction. Returns removed blobs. */
  private purgeRows(sourceId: string, nowMs: number): string[] {
    const db = this.db;
    const live = db
      .prepare(`SELECT 1 FROM media_download md WHERE source_id = @id AND ${LIVE_ATTEMPT} LIMIT 1`)
      .get({ id: sourceId, now: nowMs });
    if (live) throw new PurgeBusyError(`a running job holds a download of source ${sourceId}`);
    const queue = db.prepare(
      "INSERT OR IGNORE INTO purge_file (path, source_id, kind) VALUES (?, ?, ?)",
    );

    // Downloads stay as suppressed tombstones: the row keeps its id, so a later enqueue never
    // reuses it and a stale worker cannot attach bytes to another source, and its URL, so
    // re-enqueueing is a no-op. Their partial files are queued for removal.
    // An attempt whose lease expired may still finish an async open or write; it reaches only its
    // own attempt-named part file and removes that file itself when it ends, because the entry no
    // longer records it.
    const downloads = db
      .prepare("SELECT id, part_file FROM media_download WHERE source_id = ?")
      .all(sourceId) as { id: number; part_file: string | null }[];
    const parts = new Set(this.partialFiles(downloads.map((d) => d.id)));
    for (const d of downloads) {
      if (d.part_file !== null && PART.test(d.part_file)) parts.add(`tmp/${d.part_file}`);
    }
    for (const f of [...parts].sort()) queue.run(f, sourceId, "partial");
    db.prepare(
      `UPDATE media_download SET state = 'failed', error = ?, media_id = NULL, bytes_received = 0,
         total_bytes = NULL, etag = NULL, mime_type = NULL, claim_job_id = NULL,
         claim_generation = NULL, claim_token = NULL, part_file = NULL
       WHERE source_id = ?`,
    ).run(SUPPRESSED_PURGE, sourceId);

    const media = db
      .prepare("SELECT id, content_hash FROM media WHERE source_id = ?")
      .all(sourceId) as { id: number; content_hash: string }[];
    for (const m of media) {
      db.prepare(
        "DELETE FROM chunk WHERE derivation_id IN (SELECT id FROM derivation WHERE media_id = ?)",
      ).run(m.id);
      db.prepare("DELETE FROM derivation WHERE media_id = ?").run(m.id);
      db.prepare("DELETE FROM media WHERE id = ?").run(m.id);
      db.prepare(
        "UPDATE blob SET ref_count = ref_count - 1 WHERE content_hash = ? AND ref_count > 0",
      ).run(m.content_hash);
    }
    db.prepare(
      "DELETE FROM annotation_revision WHERE annotation_id IN (SELECT id FROM annotation WHERE source_id = ?)",
    ).run(sourceId);
    db.prepare("DELETE FROM annotation WHERE source_id = ?").run(sourceId);
    // Edges touching the source, and edges between other sources evidenced by its versions.
    db.prepare(
      `DELETE FROM relationship WHERE from_id = @id OR to_id = @id
         OR version_id IN (SELECT id FROM source_version WHERE source_id = @id)`,
    ).run({ id: sourceId });
    db.prepare(
      "DELETE FROM chunk WHERE version_id IN (SELECT id FROM source_version WHERE source_id = ?)",
    ).run(sourceId);

    // Linked sources (ENR-01): the source's own link references go, with gap records no other
    // source references. A fetch row that resolved to this source stays without page metadata, so
    // its URL keeps resolving to the tombstone (unavailable) and is not recaptured.
    const refs = (
      db.prepare("SELECT original_url FROM link_ref WHERE source_id = ?").all(sourceId) as {
        original_url: string;
      }[]
    ).map((r) => r.original_url);
    db.prepare("DELETE FROM link_ref WHERE source_id = ?").run(sourceId);
    const dropGap = db.prepare(
      `DELETE FROM linked_fetch WHERE original_url = ? AND source_id IS NULL
         AND NOT EXISTS (SELECT 1 FROM link_ref r WHERE r.original_url = linked_fetch.original_url)`,
    );
    for (const url of refs) dropGap.run(url);
    db.prepare(
      `UPDATE linked_fetch SET title = NULL, content_hash = NULL, redirect_chain = NULL,
         extraction_method = NULL WHERE source_id = ?`,
    ).run(sourceId);

    // SYN-04: the binding stays so the vault note is never re-created or re-imported; library-side
    // copies of the note (base content, hashes, review records) are removed. The vault file itself
    // is a separate copy and is not touched.
    db.prepare(
      `DELETE FROM sync_conflict WHERE EXISTS (SELECT 1 FROM sync_binding b WHERE b.source_id = ?
         AND b.library_id = sync_conflict.library_id AND b.vault_id = sync_conflict.vault_id
         AND b.note_id = sync_conflict.note_id)`,
    ).run(sourceId);
    db.prepare(
      `UPDATE sync_binding SET state = 'unlinked', suppression = 'deleted', last_common_hash = NULL,
         base_content = NULL, last_written_hash = NULL, last_txn_id = NULL WHERE source_id = ?`,
    ).run(sourceId);
    db.prepare("DELETE FROM observation WHERE source_id = ?").run(sourceId);
    db.prepare("DELETE FROM membership WHERE source_id = ?").run(sourceId);
    db.prepare("DELETE FROM source_version WHERE source_id = ?").run(sourceId);
    // The tombstone keeps only its identity (type, platform ID, canonical URL) for suppression.
    db.prepare(
      "UPDATE source SET author_id = NULL, author_handle = NULL, purged_at = ? WHERE id = ?",
    ).run(new Date(nowMs).toISOString(), sourceId);

    const gone: string[] = [];
    for (const hash of new Set(media.map((m) => m.content_hash))) {
      // The remaining media rows are authoritative in both directions: a counter that undercounts
      // (a stray release) never removes a referenced blob, and one that overcounts (legacy drift)
      // never keeps a purged source's content on disk.
      const { refs: still } = db
        .prepare("SELECT COUNT(*) refs FROM media WHERE content_hash = ? OR blob_path = ?")
        .get(hash, `blobs/${hash.slice(0, 2)}/${hash}`) as { refs: number };
      if (still > 0) {
        db.prepare("UPDATE blob SET ref_count = MAX(ref_count, ?) WHERE content_hash = ?").run(
          still,
          hash,
        );
        continue;
      }
      const r = db.prepare("DELETE FROM blob WHERE content_hash = ?").run(hash);
      if (r.changes > 0 && HASH.test(hash)) {
        gone.push(hash);
        queue.run(`blobs/${hash.slice(0, 2)}/${hash}`, sourceId, "blob");
      }
    }
    return gone.sort();
  }

  /** Partial files of the given downloads under `tmp/` (`<id>.part` and attempt-scoped names). */
  private partialFiles(ids: number[]): string[] {
    if (ids.length === 0) return [];
    let names: string[];
    try {
      names = readdirSync(join(this.opts.mediaRoot, "tmp"));
    } catch {
      return [];
    }
    const prefixes = ids.flatMap((id) => [`${id}.`, `${id}-`]);
    return names
      .filter((name) => prefixes.some((p) => name.startsWith(p)))
      .map((name) => `tmp/${name}`);
  }

  private row(sourceId: string): { trashed_at: string | null; purged_at: string | null } {
    const r = this.db
      .prepare("SELECT trashed_at, purged_at FROM source WHERE id = ?")
      .get(sourceId) as { trashed_at: string | null; purged_at: string | null } | undefined;
    if (!r) throw new UnknownSourceError(`unknown source ${sourceId}`);
    return r;
  }
}
