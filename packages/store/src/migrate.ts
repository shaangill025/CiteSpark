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
export type BackupHook = (
  fromVersion: number,
  toVersion: number,
  /** Versions about to be applied, ascending. May include a recorded gap below `fromVersion`. */
  pending: readonly number[],
) => void;

export interface MigrateOptions {
  migrations?: readonly Migration[];
  /** Required before pending migrations on an existing database (MIG-02). See {@link BackupHook}. */
  backup?: BackupHook;
}

export interface MigrateResult {
  applied: number[];
  /** Highest recorded migration version after this run. */
  version: number;
}

/** The recorded schema cannot be safely migrated by this build. Nothing was changed. */
export class MigrationStateError extends Error {
  override name = "MigrationStateError";
}

const BOOKKEEPING = `CREATE TABLE IF NOT EXISTS schema_migration (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;`;

export function migrate(db: Database.Database, options: MigrateOptions = {}): MigrateResult {
  const migrations = options.migrations ?? MIGRATIONS;
  // Inspect existing state read-only. Nothing that changes the database file, including the
  // bookkeeping table, may run before validation and (for existing data) a completed backup.
  const hadTables = hasUserTables(db);
  const hadBookkeeping = hasTable(db, "schema_migration");
  db.pragma("foreign_keys = ON"); // connection setting; does not change the database file
  const known = new Map<number, Migration>();
  for (const m of migrations) {
    if (!Number.isSafeInteger(m.version) || m.version < 1 || known.has(m.version)) {
      throw new MigrationStateError(`Invalid or duplicate migration version ${m.version}`);
    }
    known.set(m.version, m);
  }
  const latest = Math.max(0, ...known.keys());
  // Validate every recorded ID, not just the highest: a build that shipped without a lower
  // migration leaves a gap that a max-version check would silently skip.
  const recorded = hadBookkeeping
    ? (db.prepare("SELECT version, name FROM schema_migration ORDER BY version").all() as {
        version: number;
        name: string;
      }[])
    : [];
  const current = recorded.length ? recorded[recorded.length - 1]!.version : 0;
  if (current > latest) {
    throw new Error(
      `Database schema version ${current} is newer than this build supports (${latest})`,
    );
  }
  for (const r of recorded) {
    const m = known.get(r.version);
    if (!m) {
      throw new MigrationStateError(
        `Database records migration ${r.version} (${r.name}), which is unknown to this build`,
      );
    }
    if (m.name !== r.name) {
      throw new MigrationStateError(
        `Database records migration ${r.version} as "${r.name}" but this build names it "${m.name}"`,
      );
    }
  }
  const done = new Set(recorded.map((r) => r.version));
  const pending = migrations
    .filter((m) => !done.has(m.version))
    .sort((a, b) => a.version - b.version);
  // An unmarked database that already has tables is existing data too.
  const existing = current > 0 || hadTables;
  if (pending.length === 0) {
    // Only a truly empty database gets bookkeeping without pending work; existing data is
    // never written without a backup.
    if (!hadBookkeeping && !existing) db.exec(BOOKKEEPING);
    return { applied: [], version: current };
  }
  for (const m of pending) {
    if (m.version < current && !m.orderIndependent) {
      throw new MigrationStateError(
        `Missing migration ${m.version} (${m.name}) cannot be applied after recorded migration ${current}; restore a backup taken by a build that includes it`,
      );
    }
  }
  // The backup must complete before the first schema change, including bookkeeping.
  if (existing) {
    if (!options.backup) throw new Error("A recovery backup hook is required before migration");
    rejectAsync(
      options.backup(
        current,
        latest,
        pending.map((m) => m.version),
      ),
    );
  }

  const applied: number[] = [];
  let record: Database.Statement | undefined;
  for (const m of pending) {
    db.transaction(() => {
      // Bookkeeping is created with the first migration so a failure leaves neither behind.
      if (!record) {
        if (!hadBookkeeping) db.exec(BOOKKEEPING);
        record = db.prepare("INSERT INTO schema_migration (version, name) VALUES (?, ?)");
      }
      db.exec(m.sql);
      record.run(m.version, m.name);
    }).immediate();
    applied.push(m.version);
  }
  return { applied, version: Math.max(current, ...applied) };
}

function hasTable(db: Database.Database, name: string): boolean {
  return (
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !==
    undefined
  );
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
