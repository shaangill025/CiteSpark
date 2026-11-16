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
        // Waiting downloads stop; one a live job is transferring finishes into trash.
        db.prepare(
          `UPDATE media_download AS md SET state = 'failed', error = @reason,
             claim_job_id = NULL, claim_generation = NULL
           WHERE source_id = @id AND state IN ${RESUMABLE} AND NOT ${LIVE_CLAIM}`,
        ).run({ id: sourceId, reason: SUPPRESSED_TRASH, now: nowMs });
      })
      .immediate();
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
   * which only retries queued file removals. Throws PurgeBusyError, changing nothing, while a live
   * job lease holds one of the source's downloads.
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
    this.retryPendingFiles();
    const { n } = this.db
      .prepare("SELECT COUNT(*) n FROM purge_file WHERE source_id = ?")
      .get(sourceId) as { n: number };
    return { sourceId, blobsRemoved: removed, filesPending: n };
  }

  /** Explicitly purge everything currently in trash. Busy sources stay in trash and are reported. */
  emptyTrash(nowMs: number): EmptyTrashResult {
    const purged: string[] = [];
    const busy: string[] = [];
    const blobs = new Set<string>();
    let filesPending = 0;
    for (const e of this.list()) {
      try {
        const r = this.purge(e.sourceId, nowMs);
        purged.push(e.sourceId);
        r.blobsRemoved.forEach((h) => blobs.add(h));
        filesPending += r.filesPending;
      } catch (err) {
        if (!(err instanceof PurgeBusyError)) throw err;
        busy.push(e.sourceId);
      }
    }
    return { purged, busy, blobsRemoved: [...blobs].sort(), filesPending };
  }

  /**
   * Retry queued file removals (after a failed unlink, or a crash after the purge committed). A
   * queued blob whose content was stored again since (another download of the same bytes) is kept
   * and dequeued.
   */
  retryPendingFiles(): { removed: number; pending: number } {
    const rows = this.db.prepare("SELECT path, kind FROM purge_file ORDER BY path").all() as {
      path: string;
      kind: "blob" | "partial";
    }[];
    const reused = this.db.prepare("SELECT 1 FROM blob WHERE content_hash = ?");
    const done = this.db.prepare("DELETE FROM purge_file WHERE path = ?");
    let removed = 0;
    let pending = 0;
    for (const r of rows) {
      const parts = r.path.split("/");
      if (r.kind === "blob" && reused.get(parts[parts.length - 1]) !== undefined) {
        done.run(r.path);
        continue;
      }
      try {
        this.removeFile(join(this.opts.mediaRoot, ...parts));
        done.run(r.path);
        removed++;
      } catch {
        pending++;
      }
    }
    return { removed, pending };
  }

  /** Every row change of one purge; runs inside an IMMEDIATE transaction. Returns removed blobs. */
  private purgeRows(sourceId: string, nowMs: number): string[] {
    const db = this.db;
    const live = db
      .prepare(`SELECT 1 FROM media_download md WHERE source_id = @id AND ${LIVE_CLAIM} LIMIT 1`)
      .get({ id: sourceId, now: nowMs });
    if (live) throw new PurgeBusyError(`a running job holds a download of source ${sourceId}`);
    const queue = db.prepare(
      "INSERT OR IGNORE INTO purge_file (path, source_id, kind) VALUES (?, ?, ?)",
    );

    // Downloads stay as suppressed tombstones: the row keeps its id, so a later enqueue never
    // reuses it and a stale worker cannot attach bytes to another source, and its URL, so
    // re-enqueueing is a no-op. Their partial files are queued for removal.
    const downloads = db
      .prepare("SELECT id FROM media_download WHERE source_id = ?")
      .all(sourceId) as { id: number }[];
    for (const f of this.partialFiles(downloads.map((d) => d.id))) {
      queue.run(f, sourceId, "partial");
    }
    db.prepare(
      `UPDATE media_download SET state = 'failed', error = ?, media_id = NULL, bytes_received = 0,
         total_bytes = NULL, etag = NULL, mime_type = NULL, claim_job_id = NULL, claim_generation = NULL
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
      // A counter can undercount (for example after a stray release); remaining media rows win.
      const { refs: still } = db
        .prepare("SELECT COUNT(*) refs FROM media WHERE content_hash = ?")
        .get(hash) as { refs: number };
      if (still > 0) {
        db.prepare("UPDATE blob SET ref_count = MAX(ref_count, ?) WHERE content_hash = ?").run(
          still,
          hash,
        );
        continue;
      }
      const r = db.prepare("DELETE FROM blob WHERE content_hash = ? AND ref_count = 0").run(hash);
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
