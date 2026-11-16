import type Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { join } from "node:path";

export class UnknownSourceError extends Error {}
export class NotTrashedError extends Error {}
export class PurgedSourceError extends Error {}

/** `unknown` is never captured; `trashed` and `purged` evidence must be reported unavailable (DAT-04). */
export type SourceStatus = "available" | "trashed" | "purged" | "unknown";

export interface TrashEntry {
  sourceId: string;
  trashedAt: string;
}

export interface PurgeResult {
  sourceId: string;
  /** Blobs whose last reference went away and whose files were deleted. Shared blobs are kept. */
  blobsRemoved: string[];
}

export interface TrashStoreOptions {
  /** Media root that holds `blobs/`, as given to `MediaStore`. */
  mediaRoot: string;
}

const HASH = /^[0-9a-f]{64}$/;

/**
 * Recoverable trash and explicit purge (DAT-03, DAT-04, Q50). Trash only marks the source, which
 * hides it from the `active_*` views and suppresses recapture. Purge is explicit, removes
 * source-derived rows and unshared blobs by reference count, and leaves a tombstone so recapture stays
 * suppressed and retained citations report unavailable. Vault files and backups are not touched
 * (DAT-04); that disclosure belongs to the UI. Time is injected as epoch ms.
 */
export class TrashStore {
  private readonly db: Database.Database;
  private readonly opts: TrashStoreOptions;

  constructor(db: Database.Database, opts: TrashStoreOptions) {
    this.db = db;
    this.opts = opts;
  }

  trash(sourceId: string, nowMs: number): void {
    const row = this.row(sourceId);
    if (row.purged_at !== null || row.trashed_at !== null) return;
    this.db
      .prepare("UPDATE source SET trashed_at = ? WHERE id = ?")
      .run(new Date(nowMs).toISOString(), sourceId);
  }

  restore(sourceId: string): void {
    const row = this.row(sourceId);
    if (row.purged_at !== null) {
      throw new PurgedSourceError(`source ${sourceId} was purged and cannot be restored`);
    }
    this.db.prepare("UPDATE source SET trashed_at = NULL WHERE id = ?").run(sourceId);
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

  /** Permanently remove a trashed source's derived data. Idempotent for an already purged source. */
  purge(sourceId: string, nowMs: number): PurgeResult {
    const row = this.row(sourceId);
    if (row.purged_at !== null) return { sourceId, blobsRemoved: [] };
    if (row.trashed_at === null) throw new NotTrashedError(`source ${sourceId} is not in trash`);

    const orphaned = this.db
      .transaction((): string[] => {
        const db = this.db;
        const media = db
          .prepare("SELECT id, content_hash FROM media WHERE source_id = ?")
          .all(sourceId) as { id: number; content_hash: string }[];
        for (const m of media) {
          db.prepare(
            "DELETE FROM chunk WHERE derivation_id IN (SELECT id FROM derivation WHERE media_id = ?)",
          ).run(m.id);
          db.prepare("DELETE FROM derivation WHERE media_id = ?").run(m.id);
          db.prepare("UPDATE media_download SET media_id = NULL WHERE media_id = ?").run(m.id);
          db.prepare("DELETE FROM media WHERE id = ?").run(m.id);
          db.prepare(
            "UPDATE blob SET ref_count = ref_count - 1 WHERE content_hash = ? AND ref_count > 0",
          ).run(m.content_hash);
        }
        db.prepare("DELETE FROM media_download WHERE source_id = ?").run(sourceId);
        db.prepare(
          "DELETE FROM annotation_revision WHERE annotation_id IN (SELECT id FROM annotation WHERE source_id = ?)",
        ).run(sourceId);
        db.prepare("DELETE FROM annotation WHERE source_id = ?").run(sourceId);
        db.prepare("DELETE FROM relationship WHERE from_id = ? OR to_id = ?").run(
          sourceId,
          sourceId,
        );
        db.prepare(
          "DELETE FROM chunk WHERE version_id IN (SELECT id FROM source_version WHERE source_id = ?)",
        ).run(sourceId);
        // The binding stays so vault import remains suppressed; its content hash is dropped.
        db.prepare(
          "UPDATE sync_binding SET suppression = 'deleted', last_common_hash = NULL WHERE source_id = ?",
        ).run(sourceId);
        db.prepare("DELETE FROM observation WHERE source_id = ?").run(sourceId);
        db.prepare("DELETE FROM membership WHERE source_id = ?").run(sourceId);
        db.prepare("DELETE FROM source_version WHERE source_id = ?").run(sourceId);
        db.prepare(
          "UPDATE source SET canonical_url = NULL, author_id = NULL, author_handle = NULL, purged_at = ? WHERE id = ?",
        ).run(new Date(nowMs).toISOString(), sourceId);

        const gone: string[] = [];
        for (const hash of new Set(media.map((m) => m.content_hash))) {
          const r = db
            .prepare("DELETE FROM blob WHERE content_hash = ? AND ref_count = 0")
            .run(hash);
          if (r.changes > 0) gone.push(hash);
        }
        return gone.sort();
      })
      .immediate();

    // Files go after the rows commit; a crash leaves an orphan file, never a dangling reference.
    for (const hash of orphaned) {
      if (HASH.test(hash)) {
        rmSync(join(this.opts.mediaRoot, "blobs", hash.slice(0, 2), hash), { force: true });
      }
    }
    return { sourceId, blobsRemoved: orphaned };
  }

  /** Explicitly purge everything currently in trash. */
  emptyTrash(nowMs: number): { purged: string[]; blobsRemoved: string[] } {
    const purged: string[] = [];
    const blobs = new Set<string>();
    for (const e of this.list()) {
      const r = this.purge(e.sourceId, nowMs);
      purged.push(e.sourceId);
      r.blobsRemoved.forEach((h) => blobs.add(h));
    }
    return { purged, blobsRemoved: [...blobs].sort() };
  }

  private row(sourceId: string): { trashed_at: string | null; purged_at: string | null } {
    const r = this.db
      .prepare("SELECT trashed_at, purged_at FROM source WHERE id = ?")
      .get(sourceId) as { trashed_at: string | null; purged_at: string | null } | undefined;
    if (!r) throw new UnknownSourceError(`unknown source ${sourceId}`);
    return r;
  }
}
