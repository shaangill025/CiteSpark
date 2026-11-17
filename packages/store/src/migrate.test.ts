import Database from "better-sqlite3";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { migrate, MIGRATIONS, type BackupHook, type Migration } from "./index.ts";

const tables = (db: Database.Database): string[] =>
  (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);

describe("migrations", () => {
  it.each([false, true])("requires backup for existing databases (unmarked=%s)", (unmarked) => {
    const db = new Database(":memory:");
    if (unmarked) db.exec("CREATE TABLE legacy (x TEXT)");
    else migrate(db, { migrations: MIGRATIONS.slice(0, 1) });
    expect(() => migrate(db)).toThrow(/backup/i);
    expect(
      (db.pragma("table_info(job)") as { name: string }[]).some(
        (c) => c.name === "lease_generation",
      ),
    ).toBe(false);
  });

  it("adds lease generations without changing existing jobs or committed records", () => {
    const db = new Database(":memory:");
    migrate(db, { migrations: MIGRATIONS.slice(0, 1) });
    db.exec(
      "INSERT INTO job (id, kind, state, cursor) VALUES ('old', 'capture', 'queued', 'saved'); INSERT INTO source (id, source_type) VALUES ('s', 'post');",
    );
    const backups: number[] = [];
    expect(migrate(db, { backup: (from) => void backups.push(from) }).applied).toEqual([
      2, 3, 4, 5, 6,
    ]);
    expect(backups).toEqual([1]);
    expect(db.prepare("SELECT cursor, lease_generation FROM job WHERE id = 'old'").get()).toEqual({
      cursor: "saved",
      lease_generation: 0,
    });
    expect(db.prepare("SELECT id FROM source").get()).toEqual({ id: "s" });
  });

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

  it.each([
    ["an unfinished Promise", () => new Promise<void>(() => undefined)],
    ["a rejected Promise", () => Promise.reject(new Error("backup failed later"))],
    ["a custom thenable", () => ({ then: () => undefined })],
    [
      "a thenable with a throwing then getter",
      () =>
        Object.defineProperty({}, "then", {
          get() {
            throw new Error("then getter threw");
          },
        }),
    ],
  ] as const)("rejects a backup hook that returns %s before applying migrations", (_, hook) => {
    const db = new Database(":memory:");
    migrate(db, { migrations: MIGRATIONS.slice(0, 1) });
    expect(() => migrate(db, { backup: hook as unknown as BackupHook })).toThrow(/synchronous/i);
    expect(
      (db.pragma("table_info(job)") as { name: string }[]).some(
        (c) => c.name === "lease_generation",
      ),
    ).toBe(false);
    expect(db.prepare("SELECT MAX(version) v FROM schema_migration").get()).toEqual({ v: 1 });
  });

  it("rejects async backup results without an unhandled rejection in strict mode", () => {
    // A fresh process, because vitest installs its own unhandled-rejection handler.
    const script = `
      import Database from "better-sqlite3";
      import { migrate } from ${JSON.stringify(new URL("./migrate.ts", import.meta.url).href)};
      import { MIGRATIONS } from ${JSON.stringify(new URL("./migrations.ts", import.meta.url).href)};
      const hooks = [
        () => Promise.reject(new Error("native rejected")),
        () => ({ async then() { throw new Error("async custom then rejected"); } }),
        () => ({ then() { return Promise.reject(new Error("custom then returned rejection")); } }),
        () => ({ then(_ok, fail) { fail(new Error("custom then rejected")); } }),
        () => Object.defineProperty({}, "then", { get() { throw new Error("then getter threw"); } }),
      ];
      for (const backup of hooks) {
        const db = new Database(":memory:");
        migrate(db, { migrations: MIGRATIONS.slice(0, 1) });
        try { migrate(db, { backup }); console.log("migrated"); } catch { /* expected */ }
        console.log(db.prepare("SELECT MAX(version) v FROM schema_migration").get().v);
      }
      for (let i = 0; i < 3; i++) await new Promise((r) => setTimeout(r, 0));
      console.log("survived");
    `;
    const run = spawnSync(
      process.execPath,
      ["--unhandled-rejections=strict", "--input-type=module", "--eval", script],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8" },
    );
    expect(run.stderr).toBe("");
    expect(run.stdout.trim().split("\n")).toEqual(["1", "1", "1", "1", "1", "survived"]);
    expect(run.status).toBe(0);
  });

  it("rejects a database newer than this build", () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(() => migrate(db, { migrations: [] })).toThrow(/newer/);
  });
});

// Upgrade paths from every published schema. Fixtures are written with raw SQL exactly as the
// earlier max-version runner recorded them, independent of the runner under test.
describe("upgrade matrix", () => {
  const byVersion = (v: number): Migration => {
    const m = MIGRATIONS.find((x) => x.version === v);
    if (!m) throw new Error(`no migration ${v}`);
    return m;
  };
  const historical = (versions: number[], recorded = versions): Database.Database => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    db.exec(
      "CREATE TABLE schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))) STRICT;",
    );
    for (const v of versions) db.exec(byVersion(v).sql);
    const rec = db.prepare("INSERT INTO schema_migration (version, name) VALUES (?, ?)");
    for (const v of recorded) rec.run(v, byVersion(v).name);
    return db;
  };
  const recordedIds = (db: Database.Database): number[] =>
    (
      db.prepare("SELECT version FROM schema_migration ORDER BY version").all() as {
        version: number;
      }[]
    ).map((r) => r.version);
  const columns = (db: Database.Database, table: string): string[] =>
    (db.pragma(`table_info(${table})`) as { name: string }[]).map((c) => c.name);
  const seed = (db: Database.Database): void => {
    db.exec(`
      INSERT INTO source (id, source_type, platform_id) VALUES ('x:1', 'x_post', '1');
      INSERT INTO source_version (id, source_id, content_hash, text) VALUES (1, 'x:1', 'h1', 'original');
      INSERT INTO annotation (id, source_id, base_revision, text) VALUES ('a1', 'x:1', 2, 'my note');
      INSERT INTO annotation_revision (annotation_id, revision, text) VALUES ('a1', 1, 'draft');
      INSERT INTO job (id, kind, state, cursor) VALUES ('j1', 'capture', 'running', 'c42');
      INSERT INTO sync_binding (library_id, vault_id, note_id, source_id, path, last_common_hash, suppression)
        VALUES ('lib', 'vault', 'n1', 'x:1', 'Notes/x1.md', 'base', 'unlinked');
      -- Schema 1-3 allow repeated observations of one version by one job (review: V1 duplicates).
      INSERT INTO observation (id, source_id, version_id, job_id, observed_at, method, evidence)
        VALUES (1, 'x:1', 1, 'j1', '2026-01-01T00:00:00.000Z', 'import', 'first'),
               (2, 'x:1', 1, 'j1', '2026-01-02T00:00:00.000Z', 'import', 'second');
    `);
  };
  const expectSeedPreserved = (db: Database.Database): void => {
    expect(db.prepare("SELECT id, platform_id FROM source").all()).toEqual([
      { id: "x:1", platform_id: "1" },
    ]);
    expect(db.prepare("SELECT source_id, content_hash, text FROM source_version").all()).toEqual([
      { source_id: "x:1", content_hash: "h1", text: "original" },
    ]);
    expect(db.prepare("SELECT id, base_revision, text FROM annotation").all()).toEqual([
      { id: "a1", base_revision: 2, text: "my note" },
    ]);
    expect(db.prepare("SELECT revision, text FROM annotation_revision").all()).toEqual([
      { revision: 1, text: "draft" },
    ]);
    expect(db.prepare("SELECT id, state, cursor FROM job").all()).toEqual([
      { id: "j1", state: "running", cursor: "c42" },
    ]);
    expect(
      db.prepare("SELECT id, job_id, version_id, observed_at, evidence FROM observation").all(),
    ).toEqual([
      {
        id: 1,
        job_id: "j1",
        version_id: 1,
        observed_at: "2026-01-01T00:00:00.000Z",
        evidence: "first",
      },
      {
        id: 2,
        job_id: "j1",
        version_id: 1,
        observed_at: "2026-01-02T00:00:00.000Z",
        evidence: "second",
      },
    ]);
    expect(
      db.prepare("SELECT note_id, path, last_common_hash, suppression FROM sync_binding").all(),
    ).toEqual([
      { note_id: "n1", path: "Notes/x1.md", last_common_hash: "base", suppression: "unlinked" },
    ]);
  };
  const expectFullSchema = (db: Database.Database): void => {
    expect(recordedIds(db)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(tables(db)).toEqual(expect.arrayContaining(["linked_fetch", "link_ref"]));
    expect(columns(db, "job")).toContain("lease_generation");
    expect(tables(db)).toEqual(expect.arrayContaining(["blob", "media_download"]));
    expect(columns(db, "media_download")).toEqual(
      expect.arrayContaining(["claim_job_id", "claim_generation", "claim_token", "part_file"]),
    );
    expect(columns(db, "linked_fetch")).toEqual(
      expect.arrayContaining(["original_url", "canonical_url", "extraction_method", "gap_reason"]),
    );
    expect(tables(db)).toEqual(expect.arrayContaining(["capture_pass", "capture_page"]));
    expect(columns(db, "observation")).toContain("capture_page_id");
    // Capture dedupe applies to capture observations only; legacy rows keep their history.
    db.exec(`
      INSERT INTO capture_pass (job_id, pass_id, started_at) VALUES ('j1', 'p', 't');
      INSERT INTO capture_page (id, job_id, pass_id, seq, page_key, content_hash, record_count, new_records, adapter_id, adapter_version, committed_at)
        VALUES (9, 'j1', 'p', 0, '', 'h', 1, 1, 'a', '1', 't');
      INSERT INTO observation (source_id, version_id, job_id, method, capture_page_id) VALUES ('x:1', 1, 'j1', 'capture', 9);
      INSERT INTO observation (source_id, version_id, job_id, method) VALUES ('x:1', 1, 'j1', 'import');
    `);
    expect(() =>
      db.exec(
        "INSERT INTO observation (source_id, version_id, job_id, method, capture_page_id) VALUES ('x:1', 1, 'j1', 'capture', 9)",
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.exec(
        "INSERT INTO observation (source_id, version_id, job_id, method, capture_page_id) VALUES ('x:1', 1, NULL, 'capture', 999)",
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(columns(db, "sync_binding")).toEqual(
      expect.arrayContaining(["state", "base_content", "last_written_hash", "last_txn_id"]),
    );
    expect(tables(db)).toContain("sync_conflict");
    // Constraints from both additive migrations are live.
    expect(() => db.exec("UPDATE sync_binding SET state = 'bogus'")).toThrow(/CHECK/);
    expect(() =>
      db.exec("INSERT INTO sync_conflict (library_id, vault_id, kind) VALUES ('l', 'v', 'bogus')"),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(
        "INSERT INTO source_version (source_id, content_hash, text) VALUES ('x:missing', 'h', 't')",
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(() => db.exec("UPDATE job SET lease_generation = NULL")).toThrow(/NOT NULL/);
    // Media store (5): new (source, hash) duplicates and malformed download rows are refused.
    db.exec("INSERT INTO media (source_id, content_hash) VALUES ('x:1', 'mh')");
    expect(() =>
      db.exec("INSERT INTO media (source_id, content_hash) VALUES ('x:1', 'mh')"),
    ).toThrow(/UNIQUE/);
    expect(() =>
      db.exec(
        "INSERT INTO media_download (source_id, url, claim_job_id) VALUES ('x:1', 'u', 'j1')",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec("INSERT INTO media_download (source_id, url, state) VALUES ('x:1', 'u', 'complete')"),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec(
        "INSERT INTO media_download (source_id, url, bytes_received) VALUES ('x:1', 'u', -1)",
      ),
    ).toThrow(/CHECK/);
    expect(() =>
      db.exec("INSERT INTO media_download (source_id, url) VALUES ('x:missing', 'u')"),
    ).toThrow(/FOREIGN KEY/);
  };
  const recordingBackup = (db: Database.Database) => {
    const calls: { from: number; to: number; pending: readonly number[]; ids: number[] }[] = [];
    const hook: BackupHook = (from, to, pending) => {
      // The backup completes before any pending migration SQL runs.
      calls.push({ from, to, pending: [...(pending ?? [])], ids: recordedIds(db) });
    };
    return { calls, hook };
  };

  it("fresh database -> [1, 2, 3, 4, 5, 6] without a backup", () => {
    const db = new Database(":memory:");
    const calls: unknown[] = [];
    const r = migrate(db, { backup: () => void calls.push(1) });
    expect(r).toEqual({ applied: [1, 2, 3, 4, 5, 6], version: 6 });
    expect(calls).toEqual([]);
    seed(db);
    expectFullSchema(db);
  });

  it.each([
    ["v1", [1], [2, 3, 4, 5, 6]],
    ["sync-v2 (main)", [1, 2], [3, 4, 5, 6]],
    ["historical jobs-only v3 (recorded gap)", [1, 3], [2, 4, 5, 6]],
    ["jobs+sync v3", [1, 2, 3], [4, 5, 6]],
    ["capture v4", [1, 2, 3, 4], [5, 6]],
    ["media v5", [1, 2, 3, 4, 5], [6]],
  ] as const)(
    "%s -> applies exactly the missing migrations after a completed backup",
    (_, from, missing) => {
      const db = historical([...from]);
      seed(db);
      if (from.includes(2)) {
        db.exec(
          "UPDATE sync_binding SET state = 'conflict', base_content = x'00ff', last_txn_id = 't1'; INSERT INTO sync_conflict (library_id, vault_id, note_id, kind, base_text, vault_text, library_text) VALUES ('lib', 'vault', 'n1', 'merge', 'b', 'v', 'l');",
        );
      }
      if (from.includes(3)) db.exec("UPDATE job SET lease_generation = 7");
      const { calls, hook } = recordingBackup(db);

      const r = migrate(db, { backup: hook });
      expect(r).toEqual({ applied: [...missing], version: 6 });
      expect(calls).toEqual([
        { from: Math.max(...from), to: 6, pending: [...missing], ids: [...from] },
      ]);
      expectSeedPreserved(db);
      expectFullSchema(db);
      if (from.includes(2)) {
        expect(
          db.prepare("SELECT state, hex(base_content) b, last_txn_id FROM sync_binding").get(),
        ).toEqual({
          state: "conflict",
          b: "00FF",
          last_txn_id: "t1",
        });
        expect(
          db
            .prepare("SELECT kind, base_text, vault_text, library_text, status FROM sync_conflict")
            .all(),
        ).toEqual([
          { kind: "merge", base_text: "b", vault_text: "v", library_text: "l", status: "open" },
        ]);
      } else {
        expect(db.prepare("SELECT state, base_content FROM sync_binding").get()).toEqual({
          state: "bound",
          base_content: null,
        });
      }
      expect(db.prepare("SELECT lease_generation g FROM job").get()).toEqual({
        g: from.includes(3) ? 7 : 0,
      });

      // Idempotent: nothing pending, no further backup, every migration recorded exactly once.
      expect(migrate(db, { backup: hook })).toEqual({ applied: [], version: 6 });
      expect(calls).toHaveLength(1);
      expect(
        db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT version) d FROM schema_migration").get(),
      ).toEqual({ n: 6, d: 6 });
    },
  );

  it("requires a backup before filling a recorded gap", () => {
    const db = historical([1, 3]);
    expect(() => migrate(db)).toThrow(/backup/i);
    expect(recordedIds(db)).toEqual([1, 3]);
    expect(tables(db)).not.toContain("sync_conflict");
  });

  it("rolls back a failed gap migration, keeps recorded state, and succeeds on retry", () => {
    const db = historical([1, 3]);
    seed(db);
    const broken: Migration[] = MIGRATIONS.map((m) =>
      m.version === 2 ? { ...m, sql: `${m.sql}\nSELECT * FROM missing_table;` } : m,
    );
    expect(() => migrate(db, { migrations: broken, backup: () => undefined })).toThrow(
      /missing_table/,
    );
    expect(recordedIds(db)).toEqual([1, 3]);
    expect(tables(db)).not.toContain("sync_conflict");
    expect(columns(db, "sync_binding")).not.toContain("state");
    expectSeedPreserved(db);

    expect(migrate(db, { backup: () => undefined })).toEqual({ applied: [2, 4, 5, 6], version: 6 });
    expectSeedPreserved(db);
    expectFullSchema(db);
  });

  it("refuses a gap for a migration not declared order-independent, before backup or SQL", () => {
    const db = historical([1, 3]);
    const strict: Migration[] = MIGRATIONS.map((m) =>
      m.version === 2 ? { version: 2, name: m.name, sql: m.sql } : m,
    );
    const calls: unknown[] = [];
    expect(() => migrate(db, { migrations: strict, backup: () => void calls.push(1) })).toThrow(
      /migration 2 \(sync-core\).*after.*3/i,
    );
    expect(calls).toEqual([]);
    expect(recordedIds(db)).toEqual([1, 3]);
    expect(tables(db)).not.toContain("sync_conflict");
  });

  it("refuses recorded migrations this build does not know, without claiming success", () => {
    // A sync build's database opened by the jobs-only build: 2 is recorded but unknown.
    const db = historical([1, 2]);
    const jobsOnly = [byVersion(1), byVersion(3)];
    const calls: unknown[] = [];
    expect(() => migrate(db, { migrations: jobsOnly, backup: () => void calls.push(1) })).toThrow(
      /migration 2 .*unknown to this build/i,
    );
    expect(calls).toEqual([]);
    expect(recordedIds(db)).toEqual([1, 2]);
    expect(columns(db, "job")).not.toContain("lease_generation");
  });

  it("refuses a recorded migration whose name differs from this build", () => {
    const db = historical([1, 2]);
    db.exec("UPDATE schema_migration SET name = 'job-lease-generation' WHERE version = 2");
    expect(() => migrate(db, { backup: () => undefined })).toThrow(/name/i);
    expect(recordedIds(db)).toEqual([1, 2]);
    expect(columns(db, "job")).not.toContain("lease_generation");
  });

  it("refuses an unreleased capture preview database that recorded capture-commit as 2", () => {
    // PR #14's pre-integration preview numbered capture-commit 2; sync-core owns 2 when published.
    const db = historical([1], [1]);
    db.exec(
      "CREATE TABLE capture_pass (job_id TEXT); INSERT INTO schema_migration (version, name) VALUES (2, 'capture-commit');",
    );
    const calls: unknown[] = [];
    expect(() => migrate(db, { backup: () => void calls.push(1) })).toThrow(
      /migration 2 as "capture-commit".*"sync-core"/,
    );
    expect(calls).toEqual([]);
    expect(recordedIds(db)).toEqual([1, 2]);
    expect(columns(db, "job")).not.toContain("lease_generation");
  });

  it("rolls back a failed capture migration and leaves 1-3 and legacy observations intact", () => {
    const db = historical([1, 2, 3]);
    seed(db);
    const broken: Migration[] = MIGRATIONS.map((m) =>
      m.version === 4 ? { ...m, sql: `${m.sql}\nSELECT * FROM missing_table;` } : m,
    );
    expect(() => migrate(db, { migrations: broken, backup: () => undefined })).toThrow(
      /missing_table/,
    );
    expect(recordedIds(db)).toEqual([1, 2, 3]);
    expect(tables(db)).not.toContain("capture_page");
    expect(columns(db, "observation")).not.toContain("capture_page_id");
    expectSeedPreserved(db);
  });

  it("keeps legacy duplicate media rows when adding media-store 5 and refuses new ones", () => {
    const db = historical([1, 2, 3, 4]);
    seed(db);
    db.exec(`
      INSERT INTO media (id, source_id, content_hash, blob_path) VALUES
        (1, 'x:1', 'dup', 'legacy/a'), (2, 'x:1', 'dup', 'legacy/b');
    `);
    const { calls, hook } = recordingBackup(db);
    expect(migrate(db, { backup: hook })).toEqual({ applied: [5, 6], version: 6 });
    expect(calls).toEqual([{ from: 4, to: 6, pending: [5, 6], ids: [1, 2, 3, 4] }]);
    expect(db.prepare("SELECT id, content_hash, blob_path FROM media ORDER BY id").all()).toEqual([
      { id: 1, content_hash: "dup", blob_path: "legacy/a" },
      { id: 2, content_hash: "dup", blob_path: "legacy/b" },
    ]);
    expect(() =>
      db.exec("INSERT INTO media (source_id, content_hash) VALUES ('x:1', 'dup')"),
    ).toThrow(/UNIQUE/);
    expect(() => db.exec("UPDATE media SET blob_path = 'legacy/c' WHERE id = 2")).not.toThrow();
    expectSeedPreserved(db);
    expectFullSchema(db);
  });

  it("refuses an unmerged PR #9 preview database that recorded media-store as 2", () => {
    const db = historical([1], [1]);
    db.exec(
      "CREATE TABLE blob (content_hash TEXT PRIMARY KEY); INSERT INTO schema_migration (version, name) VALUES (2, 'media-store');",
    );
    const before = db.serialize();
    const calls: unknown[] = [];
    expect(() => migrate(db, { backup: () => void calls.push(1) })).toThrow(
      /migration 2 as "media-store".*"sync-core"/,
    );
    expect(calls).toEqual([]);
    expect(db.serialize().equals(before)).toBe(true);
  });

  it("refuses an unmerged PR #13 preview database that recorded linked-sources as 3", () => {
    // PR #13's pre-integration preview numbered linked-sources 3; job-lease-generation owns 3.
    const db = historical([1], [1]);
    db.exec(
      "CREATE TABLE linked_fetch (original_url TEXT); INSERT INTO schema_migration (version, name) VALUES (3, 'linked-sources');",
    );
    const before = db.serialize();
    const calls: unknown[] = [];
    expect(() => migrate(db, { backup: () => void calls.push(1) })).toThrow(
      /migration 3 as "linked-sources".*"job-lease-generation"/,
    );
    expect(calls).toEqual([]);
    expect(db.serialize().equals(before)).toBe(true);
  });

  it("rolls back a failed linked-sources migration and leaves 1-5 intact", () => {
    const db = historical([1, 2, 3, 4, 5]);
    seed(db);
    const broken: Migration[] = MIGRATIONS.map((m) =>
      m.version === 6 ? { ...m, sql: `${m.sql}\nSELECT * FROM missing_table;` } : m,
    );
    expect(() => migrate(db, { migrations: broken, backup: () => undefined })).toThrow(
      /missing_table/,
    );
    expect(recordedIds(db)).toEqual([1, 2, 3, 4, 5]);
    expect(tables(db)).not.toContain("linked_fetch");
    expect(tables(db)).not.toContain("link_ref");
    expectSeedPreserved(db);
    expect(migrate(db, { backup: () => undefined })).toEqual({ applied: [6], version: 6 });
    expectFullSchema(db);
  });

  it("rolls back a failed media migration and leaves 1-4 intact", () => {
    const db = historical([1, 2, 3, 4]);
    seed(db);
    const broken: Migration[] = MIGRATIONS.map((m) =>
      m.version === 5 ? { ...m, sql: `${m.sql}\nSELECT * FROM missing_table;` } : m,
    );
    expect(() => migrate(db, { migrations: broken, backup: () => undefined })).toThrow(
      /missing_table/,
    );
    expect(recordedIds(db)).toEqual([1, 2, 3, 4]);
    expect(tables(db)).not.toContain("blob");
    expect(tables(db)).not.toContain("media_download");
    expectSeedPreserved(db);
    expect(migrate(db, { backup: () => undefined })).toEqual({ applied: [5, 6], version: 6 });
    expectFullSchema(db);
  });

  it("still rejects a newer database, including one with a gap", () => {
    const db = historical([1, 3]);
    db.prepare("INSERT INTO schema_migration (version, name) VALUES (7, 'future')").run();
    expect(() => migrate(db, { backup: () => undefined })).toThrow(/newer/);
    expect(recordedIds(db)).toEqual([1, 3, 7]);
    expect(tables(db)).not.toContain("sync_conflict");
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
    db.prepare(
      "INSERT INTO collection (account_id, id) VALUES ('acct-a', 'bookmarks'), ('acct-b', 'bookmarks')",
    ).run();
    const m = db.prepare(
      "INSERT INTO membership (account_id, collection_id, source_id) VALUES (?, 'bookmarks', ?)",
    );
    m.run("acct-a", "x:1");
    m.run("acct-b", "x:1");
    expect(() => m.run("acct-a", "x:missing")).toThrow();
    expect(() => m.run("acct-c", "x:1")).toThrow(); // no such collection for this account
  });

  it("enables foreign keys itself and pairs observations with their own source's version", () => {
    const db = new Database(":memory:");
    migrate(db);
    const src = db.prepare("INSERT INTO source (id, source_type) VALUES (?, 'x_post')");
    src.run("x:1");
    src.run("x:2");
    db.prepare(
      "INSERT INTO source_version (id, source_id, content_hash, text) VALUES (1, 'x:1', 'h', 't')",
    ).run();
    const obs = db.prepare(
      "INSERT INTO observation (source_id, version_id, method) VALUES (?, ?, 'test')",
    );
    obs.run("x:1", 1);
    expect(() => obs.run("x:2", 1)).toThrow();
  });

  it("backs up an unmarked database that already has tables", () => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE legacy (x TEXT)");
    const calls: number[] = [];
    migrate(db, { backup: (f) => void calls.push(f) });
    expect(calls).toEqual([0]);
  });

  const legacyDb = (): Database.Database => {
    const db = new Database(":memory:");
    db.exec("CREATE TABLE legacy (payload TEXT); INSERT INTO legacy VALUES ('preserve');");
    return db;
  };

  it.each([
    ["absent", undefined],
    [
      "throwing",
      () => {
        throw new Error("backup refused");
      },
    ],
    ["a rejected Promise", () => Promise.reject(new Error("late backup"))],
    ["a custom thenable", () => ({ then: () => undefined })],
  ] as const)(
    "leaves an unmarked existing database byte-identical when the backup hook is %s",
    (_, backup) => {
      const db = legacyDb();
      const before = db.serialize();
      expect(() => migrate(db, { backup: backup as BackupHook | undefined })).toThrow();
      expect(db.serialize().equals(before)).toBe(true);
      expect(tables(db)).toEqual(["legacy"]);
    },
  );

  it("completes the backup of an unmarked database before creating bookkeeping", () => {
    const db = legacyDb();
    const seen: { live: string[]; copy: string[]; rows: unknown[] }[] = [];
    const result = migrate(db, {
      backup: () => {
        // A real synchronous copy, taken while the hook runs.
        const copy = new Database(db.serialize());
        seen.push({
          live: tables(db),
          copy: tables(copy),
          rows: copy.prepare("SELECT * FROM legacy").all(),
        });
        copy.close();
      },
    });
    expect(seen).toEqual([{ live: ["legacy"], copy: ["legacy"], rows: [{ payload: "preserve" }] }]);
    expect(result).toEqual({ applied: MIGRATIONS.map((m) => m.version), version: 6 });
    expect(db.prepare("SELECT * FROM legacy").all()).toEqual([{ payload: "preserve" }]);
  });

  it("validates an unmarked database without writing when there is nothing to apply", () => {
    const db = legacyDb();
    const before = db.serialize();
    expect(migrate(db, { migrations: [] })).toEqual({ applied: [], version: 0 });
    expect(db.serialize().equals(before)).toBe(true);
    expect(() =>
      migrate(db, { migrations: [{ version: 0, name: "bad", sql: "SELECT 1;" }] }),
    ).toThrow(/Invalid/);
    expect(db.serialize().equals(before)).toBe(true);
  });

  it("creates bookkeeping on a truly empty database without a backup", () => {
    const empty = new Database(":memory:");
    expect(migrate(empty, { migrations: [] })).toEqual({ applied: [], version: 0 });
    expect(tables(empty)).toEqual(["schema_migration"]);
    const fresh = new Database(":memory:");
    expect(migrate(fresh).applied).toEqual([1, 2, 3, 4, 5, 6]);
    expect(migrate(fresh)).toEqual({ applied: [], version: 6 });
  });
});
