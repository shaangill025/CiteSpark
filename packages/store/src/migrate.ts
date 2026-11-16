import type Database from "better-sqlite3";
import { MIGRATIONS, type Migration } from "./migrations.ts";

export type BackupHook = (fromVersion: number, toVersion: number) => void;

export interface MigrateOptions {
  migrations?: readonly Migration[];
  /** Runs before any pending migration on a database that already holds data (MIG-02). A throw aborts. */
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
  // A database stamped by a sibling branch that numbered its migrations differently must not be
  // silently treated as up to date.
  const recorded = db.prepare("SELECT version, name FROM schema_migration").all() as {
    version: number;
    name: string;
  }[];
  for (const r of recorded) {
    const known = migrations.find((m) => m.version === r.version);
    if (known && known.name !== r.name) {
      throw new Error(
        `Database migration ${r.version} is "${r.name}" but this build defines "${known.name}"`,
      );
    }
  }
  const pending = migrations
    .filter((m) => m.version > current)
    .sort((a, b) => a.version - b.version);
  if (pending.length === 0) return { applied: [], version: current };
  if (current > 0) options.backup?.(current, latest);

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
