import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, type Migration } from "./index.ts";

const tables = (db: Database.Database): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

describe("migrations", () => {
  it("applies all migrations to an empty database and is idempotent", () => {
    const db = new Database(":memory:");
    const r = migrate(db);
    expect(r.applied).toEqual(MIGRATIONS.map((m) => m.version));
    expect(tables(db)).toEqual(
      expect.arrayContaining([
        "source",
        "source_version",
        "observation",
        "collection",
        "membership",
        "relationship",
        "annotation",
        "annotation_revision",
        "media",
        "derivation",
        "chunk",
        "job",
        "sync_binding",
        "sync_conflict",
        "answer",
        "privacy_policy",
        "backup_manifest",
        "index_state",
      ]),
    );
    expect(migrate(db).applied).toEqual([]);
  });

  it("rolls back a failed migration and keeps earlier ones", () => {
    const db = new Database(":memory:");
    const ms: Migration[] = [
      { version: 1, name: "ok", sql: "CREATE TABLE a (x TEXT) STRICT;" },
      { version: 2, name: "bad", sql: "CREATE TABLE b (x TEXT) STRICT; SELECT * FROM nope;" },
    ];
    expect(() => migrate(db, { migrations: ms })).toThrow();
    expect(tables(db)).toContain("a");
    expect(tables(db)).not.toContain("b");
    const v = db.prepare("SELECT MAX(version) v FROM schema_migration").get() as { v: number };
    expect(v.v).toBe(1);
  });

  it("runs the backup hook before migrating an existing database, and aborts if it fails", () => {
    const db = new Database(":memory:");
    const first: Migration = { version: 1, name: "a", sql: "CREATE TABLE a (x TEXT) STRICT;" };
    const second: Migration = { version: 2, name: "b", sql: "CREATE TABLE b (x TEXT) STRICT;" };
    const calls: [number, number][] = [];
    migrate(db, { migrations: [first], backup: (f, t) => void calls.push([f, t]) });
    expect(calls).toEqual([]); // fresh database: nothing to back up
    migrate(db, { migrations: [first, second], backup: (f, t) => void calls.push([f, t]) });
    expect(calls).toEqual([[1, 2]]);

    const db2 = new Database(":memory:");
    migrate(db2, { migrations: [first] });
    expect(() =>
      migrate(db2, {
        migrations: [first, second],
        backup: () => {
          throw new Error("disk full");
        },
      }),
    ).toThrow("disk full");
    expect(tables(db2)).not.toContain("b");
  });

  it("rejects a database newer than this build", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db, { migrations: [] })).toThrow(/newer/);
  });
});

describe("schema contracts", () => {
  const setup = (): Database.Database => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    migrate(db);
    return db;
  };

  it("round-trips 19-digit platform IDs exactly", () => {
    const db = setup();
    const id = "1234567890123456789";
    expect(Number(id).toString()).not.toBe(id); // exceeds safe integer range
    db.prepare("INSERT INTO source (id, source_type, platform_id) VALUES (?, 'x_post', ?)").run(
      `x:${id}`,
      id,
    );
    const row = db.prepare("SELECT id, platform_id FROM source WHERE platform_id = ?").get(id) as {
      id: string;
      platform_id: string;
    };
    expect(row).toEqual({ id: `x:${id}`, platform_id: id });
    expect(typeof row.platform_id).toBe("string");
  });

  it("keeps identical text under different IDs distinct, and merges repeated IDs", () => {
    const db = setup();
    const src = db.prepare(
      "INSERT OR IGNORE INTO source (id, source_type, platform_id) VALUES (?, 'x_post', ?)",
    );
    const ver = db.prepare(
      "INSERT OR IGNORE INTO source_version (source_id, content_hash, text) VALUES (?, 'h1', 'same text')",
    );
    for (const id of ["1000000000000000001", "1000000000000000002", "1000000000000000001"]) {
      src.run(`x:${id}`, id);
      ver.run(`x:${id}`);
    }
    expect((db.prepare("SELECT COUNT(*) n FROM source").get() as { n: number }).n).toBe(2);
    expect((db.prepare("SELECT COUNT(*) n FROM source_version").get() as { n: number }).n).toBe(2);
  });

  it("keeps distinct snapshots for a repeated source ID", () => {
    const db = setup();
    db.prepare(
      "INSERT INTO source (id, source_type, platform_id) VALUES ('x:1', 'x_post', '1')",
    ).run();
    const ver = db.prepare(
      "INSERT INTO source_version (source_id, content_hash, text) VALUES ('x:1', ?, ?)",
    );
    ver.run("h1", "v1");
    ver.run("h2", "v2");
    expect(() => ver.run("h2", "v2")).toThrow();
    expect((db.prepare("SELECT COUNT(*) n FROM source_version").get() as { n: number }).n).toBe(2);
  });

  it("scopes membership by account and enforces references", () => {
    const db = setup();
    db.prepare(
      "INSERT INTO source (id, source_type, platform_id) VALUES ('x:1', 'x_post', '1')",
    ).run();
    const m = db.prepare(
      "INSERT INTO membership (account_id, collection_id, source_id) VALUES (?, 'bookmarks', ?)",
    );
    m.run("acct-a", "x:1");
    m.run("acct-b", "x:1");
    expect(() => m.run("acct-a", "x:missing")).toThrow();
  });
});
