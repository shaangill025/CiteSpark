import type Database from "better-sqlite3";
import { gunzipSync, gzipSync } from "node:zlib";
import type { BindingState } from "./identity.ts";
import type { NoteConflict, NoteVersions } from "./merge-note.ts";
import { contentHash } from "./text.ts";

export interface BindingKey {
  libraryId: string;
  vaultId: string;
  noteId: string;
}

export interface Binding extends BindingKey {
  sourceId: string | null;
  path: string;
  state: BindingState;
  suppression: "none" | "unlinked" | "deleted";
  /** Last common revision. Stored gzip-compressed (ADR 0007), verified against `baseHash` on read. */
  base: string | null;
  baseHash: string | null;
  lastWrittenHash: string | null;
  lastTxnId: string | null;
}

interface BindingRow {
  library_id: string;
  vault_id: string;
  note_id: string;
  source_id: string | null;
  path: string;
  last_common_hash: string | null;
  suppression: Binding["suppression"];
  state: BindingState;
  base_content: Buffer | null;
  last_written_hash: string | null;
  last_txn_id: string | null;
}

export function saveBinding(db: Database.Database, b: Binding): void {
  const baseHash = b.base === null ? null : contentHash(b.base);
  if (b.base !== null && b.baseHash !== null && b.baseHash !== baseHash) {
    throw new Error(`Base content does not match base hash for note ${b.noteId}`);
  }
  db.prepare(
    `INSERT INTO sync_binding (library_id, vault_id, note_id, source_id, path, last_common_hash,
       suppression, state, base_content, last_written_hash, last_txn_id)
     VALUES (@libraryId, @vaultId, @noteId, @sourceId, @path, @baseHash, @suppression, @state,
       @baseContent, @lastWrittenHash, @lastTxnId)
     ON CONFLICT (library_id, vault_id, note_id) DO UPDATE SET source_id = excluded.source_id,
       path = excluded.path, last_common_hash = excluded.last_common_hash,
       suppression = excluded.suppression, state = excluded.state,
       base_content = excluded.base_content, last_written_hash = excluded.last_written_hash,
       last_txn_id = excluded.last_txn_id`,
  ).run({
    libraryId: b.libraryId,
    vaultId: b.vaultId,
    noteId: b.noteId,
    sourceId: b.sourceId,
    path: b.path,
    baseHash: baseHash ?? b.baseHash,
    suppression: b.suppression,
    state: b.state,
    baseContent: b.base === null ? null : gzipSync(Buffer.from(b.base, "utf8")),
    lastWrittenHash: b.lastWrittenHash,
    lastTxnId: b.lastTxnId,
  });
}

function toBinding(r: BindingRow): Binding {
  const base = r.base_content === null ? null : gunzipSync(r.base_content).toString("utf8");
  if (base !== null && r.last_common_hash !== contentHash(base)) {
    throw new Error(`Stored base for note ${r.note_id} does not match its hash`);
  }
  return {
    libraryId: r.library_id,
    vaultId: r.vault_id,
    noteId: r.note_id,
    sourceId: r.source_id,
    path: r.path,
    state: r.state,
    suppression: r.suppression,
    base,
    baseHash: r.last_common_hash,
    lastWrittenHash: r.last_written_hash,
    lastTxnId: r.last_txn_id,
  };
}

export function getBinding(db: Database.Database, key: BindingKey): Binding | null {
  const row = db
    .prepare("SELECT * FROM sync_binding WHERE library_id = ? AND vault_id = ? AND note_id = ?")
    .get(key.libraryId, key.vaultId, key.noteId) as BindingRow | undefined;
  return row ? toBinding(row) : null;
}

export function listBindings(db: Database.Database, libraryId: string, vaultId: string): Binding[] {
  const rows = db
    .prepare("SELECT * FROM sync_binding WHERE library_id = ? AND vault_id = ? ORDER BY note_id")
    .all(libraryId, vaultId) as BindingRow[];
  return rows.map(toBinding);
}

export type ConflictKind =
  | "merge"
  | "duplicate_id"
  | "delete_vs_edit"
  | "restore_candidate"
  | "unbound_file"
  | "source_edit";

export type ConflictStatus = "open" | "resolved" | "dismissed";

export interface ConflictRecord {
  id?: number;
  libraryId: string;
  vaultId: string;
  noteId: string | null;
  path: string | null;
  kind: ConflictKind;
  /** Variants kept verbatim for review (SYN-03). */
  base: string | null;
  vault: string | null;
  library: string | null;
  details: unknown;
  status?: ConflictStatus;
}

/** Builds the record for a merge conflict: all three versions verbatim plus the conflict list. */
export function mergeConflictRecord(
  key: BindingKey,
  path: string,
  versions: NoteVersions,
  conflicts: readonly NoteConflict[],
): ConflictRecord {
  return {
    libraryId: key.libraryId,
    vaultId: key.vaultId,
    noteId: key.noteId,
    path,
    kind: "merge",
    base: versions.base,
    vault: versions.vault,
    library: versions.library,
    details: { conflicts },
  };
}

// Details are a JSON preview; the raw YAML variants above remain the lossless record.
function toJson(value: unknown): string {
  const ancestors: object[] = [];
  return JSON.stringify(value ?? {}, function (this: unknown, _key, x: unknown) {
    if (typeof x === "bigint") return x.toString();
    if (typeof x !== "object" || x === null) return x;
    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
    if (ancestors.includes(x)) return "[Circular]";
    ancestors.push(x);
    return x;
  });
}

export function recordConflict(db: Database.Database, c: ConflictRecord): number {
  const r = db
    .prepare(
      `INSERT INTO sync_conflict (library_id, vault_id, note_id, path, kind, base_text, vault_text,
         library_text, details, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      c.libraryId,
      c.vaultId,
      c.noteId,
      c.path,
      c.kind,
      c.base,
      c.vault,
      c.library,
      toJson(c.details),
      c.status ?? "open",
    );
  return Number(r.lastInsertRowid);
}

interface ConflictRow {
  id: number;
  library_id: string;
  vault_id: string;
  note_id: string | null;
  path: string | null;
  kind: ConflictKind;
  base_text: string | null;
  vault_text: string | null;
  library_text: string | null;
  details: string;
  status: ConflictStatus;
}

export function listConflicts(
  db: Database.Database,
  libraryId: string,
  vaultId: string,
  status: ConflictStatus = "open",
): ConflictRecord[] {
  const rows = db
    .prepare(
      "SELECT * FROM sync_conflict WHERE library_id = ? AND vault_id = ? AND status = ? ORDER BY id",
    )
    .all(libraryId, vaultId, status) as ConflictRow[];
  return rows.map((r) => ({
    id: r.id,
    libraryId: r.library_id,
    vaultId: r.vault_id,
    noteId: r.note_id,
    path: r.path,
    kind: r.kind,
    base: r.base_text,
    vault: r.vault_text,
    library: r.library_text,
    details: JSON.parse(r.details) as unknown,
    status: r.status,
  }));
}

export function setConflictStatus(db: Database.Database, id: number, status: ConflictStatus): void {
  const r = db
    .prepare(
      `UPDATE sync_conflict SET status = ?,
         resolved_at = CASE WHEN ? = 'open' THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%fZ', 'now') END
       WHERE id = ?`,
    )
    .run(status, status, id);
  if (r.changes !== 1) throw new Error(`No sync conflict with id ${id}`);
}
