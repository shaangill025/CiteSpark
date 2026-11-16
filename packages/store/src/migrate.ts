import type Database from "better-sqlite3";
import { types } from "node:util";
import { MIGRATIONS, type Migration } from "./migrations.ts";

/**
 * Synchronous recovery backup. It must finish before returning; a throw aborts the migration.
 * Returning a Promise or other thenable (for example better-sqlite3's async `db.backup()`) is
 * rejected before any migration runs, because `migrate` cannot wait for it. Finish an async backup
 * first, then call `migrate` with a hook that confirms it. A rejected native Promise is marked
 * handled; a custom thenable's `then` is read once (a throwing accessor also aborts) but never
 * called, so `migrate` runs no code from it.
 */
export type BackupHook = (fromVersion: number, toVersion: number) => void;

export interface MigrateOptions {
  migrations?: readonly Migration[];
  /** Required before pending migrations on an existing database (MIG-02). See {@link BackupHook}. */
  backup?: BackupHook;
}

export interface MigrateResult {
  applied: number[];
  version: number;
}

const BOOKKEEPING = `CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;`;

export function migrate(db: Database.Database, options: MigrateOptions = {}): MigrateResult {
  const migrations = options.migrations ?? MIGRATIONS;
  const hadTables = hasUserTables(db);
  db.pragma("foreign_keys = ON");
  db.exec(BOOKKEEPING);
  const current = (
    db.prepare("SELECT COALESCE(MAX(version), 0) v FROM schema_migration").get() as { v: number }
  ).v;
  const latest = migrations.reduce((max, m) => Math.max(max, m.version), 0);
  if (current > latest) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${latest})`,
    );
  }
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return { applied: [], version: current };
  // An unmarked database that already has tables is existing data too.
  if (current > 0 || hadTables) {
    if (!options.backup) throw new Error("A recovery backup hook is required before migration");
    rejectAsync(options.backup(current, latest));
  }

  const record = db.prepare("INSERT INTO schema_migration (version, name) VALUES (?, ?)");
  const applied: number[] = [];
  for (const m of pending) {
    db.transaction(() => {
      db.exec(m.sql);
      record.run(m.version, m.name);
    }).immediate();
    applied.push(m.version);
  }
  return { applied, version: latest };
}

function hasUserTables(db: Database.Database): boolean {
  return (
    db
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migration' LIMIT 1",
      )
      .get() !== undefined
  );
}

const ASYNC_BACKUP = "The recovery backup hook must be synchronous; it returned a Promise";

/** Throws if a backup hook result is a Promise or thenable, never calling its `then`. */
function rejectAsync(result: unknown): void {
  if (types.isPromise(result)) {
    // Native (any realm): mark a later rejection handled without calling an overridden `then`.
    try {
      Promise.prototype.then.call(result, undefined, () => undefined);
    } catch {
      // A hostile subclass constructor; nothing else to suppress.
    }
    throw new Error(ASYNC_BACKUP);
  }
  if ((typeof result !== "object" && typeof result !== "function") || result === null) return;
  let then: unknown;
  try {
    then = (result as { then?: unknown }).then; // read once
  } catch (cause) {
    throw new Error(
      "The recovery backup hook must be synchronous; reading `then` on its result failed",
      { cause },
    );
  }
  if (typeof then === "function") throw new Error(ASYNC_BACKUP);
}
