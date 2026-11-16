// T07 (store part): trash excludes at once, survives restart, suppresses recapture; purge removes
// unshared derived data and keeps shared blobs (DAT-03, DAT-04, Q50). Synthetic data only.
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CaptureStore,
  JobStore,
  NotTrashedError,
  PurgedSourceError,
  TrashStore,
  UnknownSourceError,
  migrate,
  type CapturePage,
} from "./index.ts";

const T0 = 1_800_000_000_000;
const HASH_SHARED = "a".repeat(64);
const HASH_ONLY_A = "b".repeat(64);
const A = "x_post:1800000000000000001";
const B = "x_post:1800000000000000002";

let dir: string;
let dbPath: string;
let db: Database.Database;

const open = (): Database.Database => {
  const d = new Database(dbPath);
  d.pragma("foreign_keys = ON");
  migrate(d);
  return d;
};
const n = (sql: string, ...args: unknown[]): number =>
  (db.prepare(`SELECT COUNT(*) n FROM (${sql})`).get(...args) as { n: number }).n;
const blobFile = (hash: string): string => join(dir, "blobs", hash.slice(0, 2), hash);

function seed(): void {
  db.prepare("INSERT INTO collection (account_id, id) VALUES ('acct', 'col')").run();
  for (const [id, pid] of [
    [A, "1800000000000000001"],
    [B, "1800000000000000002"],
  ] as const) {
    db.prepare(
      "INSERT INTO source (id, source_type, platform_id, canonical_url, author_handle) VALUES (?, 'x_post', ?, 'https://example.test/p', 'synthetic')",
    ).run(id, pid);
    const v = Number(
      db
        .prepare(
          "INSERT INTO source_version (source_id, content_hash, text) VALUES (?, 'h', 'synthetic text')",
        )
        .run(id).lastInsertRowid,
    );
    db.prepare(
      "INSERT INTO chunk (version_id, text, text_hash, document_type) VALUES (?, 'synthetic text', 'h', 'post')",
    ).run(v);
    db.prepare(
      "INSERT INTO observation (source_id, version_id, method) VALUES (?, ?, 'capture')",
    ).run(id, v);
    db.prepare(
      "INSERT INTO membership (account_id, collection_id, source_id) VALUES ('acct', 'col', ?)",
    ).run(id);
  }
  db.prepare("INSERT INTO blob (content_hash, size_bytes, ref_count) VALUES (?, 3, 2)").run(
    HASH_SHARED,
  );
  db.prepare("INSERT INTO blob (content_hash, size_bytes, ref_count) VALUES (?, 3, 1)").run(
    HASH_ONLY_A,
  );
  const media = (src: string, hash: string): number =>
    Number(
      db
        .prepare(
          "INSERT INTO media (source_id, content_hash, blob_path, mime_type) VALUES (?, ?, ?, 'image/png')",
        )
        .run(src, hash, `blobs/${hash.slice(0, 2)}/${hash}`).lastInsertRowid,
    );
  const mA1 = media(A, HASH_SHARED);
  media(A, HASH_ONLY_A);
  media(B, HASH_SHARED);
  db.prepare(
    "INSERT INTO derivation (media_id, kind, text) VALUES (?, 'ocr', 'synthetic ocr')",
  ).run(mA1);
  db.prepare(
    "INSERT INTO media_download (source_id, url, state, media_id) VALUES (?, 'https://example.test/a.png', 'complete', ?)",
  ).run(A, mA1);
  db.prepare(
    "INSERT INTO chunk (version_id, derivation_id, text, text_hash, document_type) VALUES ((SELECT id FROM source_version WHERE source_id = ?), (SELECT id FROM derivation LIMIT 1), 'synthetic ocr', 'o', 'ocr')",
  ).run(A);
  db.prepare(
    "INSERT INTO sync_binding (library_id, vault_id, note_id, source_id, path, last_common_hash) VALUES ('l', 'v', 'n', ?, 'Notes/a.md', 'h')",
  ).run(A);
  db.prepare("INSERT INTO annotation (id, source_id, text) VALUES ('n1', ?, 'note')").run(A);
  db.prepare(
    "INSERT INTO annotation_revision (annotation_id, revision, text) VALUES ('n1', 1, 'note')",
  ).run();
  db.prepare(
    "INSERT INTO relationship (from_id, to_id, type, origin) VALUES (?, ?, 'quotes', 'captured')",
  ).run(A, B);
  mkdirSync(join(dir, "blobs", "aa"), { recursive: true });
  mkdirSync(join(dir, "blobs", "bb"), { recursive: true });
  writeFileSync(blobFile(HASH_SHARED), "abc");
  writeFileSync(blobFile(HASH_ONLY_A), "abc");
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "citspark-trash-"));
  dbPath = join(dir, "lib.sqlite");
  db = open();
  seed();
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("trash", () => {
  it("excludes a trashed source from active views at once and restores it", () => {
    const t = new TrashStore(db, { mediaRoot: dir });
    expect(n("SELECT 1 FROM active_chunk")).toBe(3);
    t.trash(A, T0);
    expect(n("SELECT 1 FROM active_chunk")).toBe(1);
    expect(n("SELECT 1 FROM active_source WHERE id = ?", A)).toBe(0);
    expect(t.list().map((r) => r.sourceId)).toEqual([A]);
    t.restore(A);
    expect(n("SELECT 1 FROM active_chunk")).toBe(3);
    expect(t.list()).toEqual([]);
    expect(t.status(A)).toBe("available");
  });

  it("is idempotent and rejects unknown sources", () => {
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.trash(A, T0 + 1000);
    expect(t.list()[0]?.trashedAt).toBe(new Date(T0).toISOString());
    expect(() => t.trash("x_post:nope", T0)).toThrow(UnknownSourceError);
  });

  it("survives restart", () => {
    new TrashStore(db, { mediaRoot: dir }).trash(A, T0);
    db.close();
    db = open();
    const t = new TrashStore(db, { mediaRoot: dir });
    expect(n("SELECT 1 FROM active_chunk")).toBe(1);
    expect(t.status(A)).toBe("trashed");
  });

  it("suppresses recapture until restored", () => {
    const jobs = new JobStore(db);
    const capture = new CaptureStore(db, jobs);
    jobs.create({ id: "j", kind: "capture", accountId: "acct", collectionId: "col" });
    const lease = jobs.acquire("j", "o", T0, 60_000);
    if (!lease) throw new Error("setup could not acquire the lease");
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    const page: CapturePage = {
      passId: "p1",
      accountId: "acct",
      collectionId: "col",
      cursorIn: null,
      cursorOut: null,
      adapter: { id: "synthetic", version: "1" },
      records: [
        { sourceType: "x_post", platformId: "1800000000000000001", text: "edited elsewhere" },
        { sourceType: "x_post", platformId: "1800000000000000009", text: "new" },
      ],
    };
    capture.commitPage("j", lease, T0, page);
    expect(n("SELECT 1 FROM source_version WHERE source_id = ?", A)).toBe(1);
    expect(n("SELECT 1 FROM observation WHERE job_id = 'j' AND source_id = ?", A)).toBe(0);
    expect(n("SELECT 1 FROM source WHERE id = 'x_post:1800000000000000009'")).toBe(1);
  });
});

describe("purge", () => {
  it("refuses a source that is not in trash", () => {
    const t = new TrashStore(db, { mediaRoot: dir });
    expect(() => t.purge(A, T0)).toThrow(NotTrashedError);
  });

  it("removes unshared derived data, keeps shared blobs, and leaves a tombstone", () => {
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    const r = t.purge(A, T0 + 1);
    expect(r.blobsRemoved).toEqual([HASH_ONLY_A]);
    expect(existsSync(blobFile(HASH_ONLY_A))).toBe(false);
    expect(existsSync(blobFile(HASH_SHARED))).toBe(true);
    expect(
      db.prepare("SELECT ref_count FROM blob WHERE content_hash = ?").get(HASH_SHARED),
    ).toEqual({ ref_count: 1 });
    expect(n("SELECT 1 FROM blob WHERE content_hash = ?", HASH_ONLY_A)).toBe(0);
    for (const table of [
      "media",
      "derivation",
      "media_download",
      "annotation",
      "annotation_revision",
      "relationship",
      "observation",
      "membership",
    ]) {
      const where =
        table === "media" || table === "media_download"
          ? "source_id"
          : table === "annotation"
            ? "source_id"
            : null;
      if (where) expect(n(`SELECT 1 FROM ${table} WHERE ${where} = ?`, A)).toBe(0);
    }
    expect(n("SELECT 1 FROM derivation")).toBe(0);
    expect(db.prepare("SELECT suppression, last_common_hash FROM sync_binding").get()).toEqual({
      suppression: "deleted",
      last_common_hash: null,
    });
    expect(n("SELECT 1 FROM annotation_revision")).toBe(0);
    expect(n("SELECT 1 FROM relationship")).toBe(0);
    expect(n("SELECT 1 FROM source_version WHERE source_id = ?", A)).toBe(0);
    expect(n("SELECT 1 FROM chunk")).toBe(1);
    // The other source is untouched.
    expect(n("SELECT 1 FROM media WHERE source_id = ?", B)).toBe(1);
    expect(n("SELECT 1 FROM membership WHERE source_id = ?", B)).toBe(1);
    expect(
      db.prepare("SELECT canonical_url, author_handle, purged_at FROM source WHERE id = ?").get(A),
    ).toEqual({
      canonical_url: null,
      author_handle: null,
      purged_at: new Date(T0 + 1).toISOString(),
    });
  });

  it("removes a shared blob once its last reference is purged", () => {
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    t.trash(B, T0);
    expect(t.purge(B, T0).blobsRemoved).toEqual([HASH_SHARED]);
    expect(existsSync(blobFile(HASH_SHARED))).toBe(false);
  });

  it("keeps suppression and reports purged evidence as unavailable, never another source", () => {
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    expect(t.status(A)).toBe("purged");
    expect(t.status("x_post:never-seen")).toBe("unknown");
    expect(() => t.restore(A)).toThrow(PurgedSourceError);
    expect(t.purge(A, T0).blobsRemoved).toEqual([]);
  });

  it("empties trash explicitly and only purges trashed sources", () => {
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    expect(t.emptyTrash(T0).purged).toEqual([A]);
    expect(t.status(B)).toBe("available");
    expect(n("SELECT 1 FROM media WHERE source_id = ?", B)).toBe(1);
  });

  it("rolls back every change when a purge fails midway", () => {
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    db.exec(
      "CREATE TRIGGER boom BEFORE DELETE ON source_version BEGIN SELECT RAISE(ABORT, 'boom'); END;",
    );
    expect(() => t.purge(A, T0)).toThrow(/boom/);
    expect(n("SELECT 1 FROM media WHERE source_id = ?", A)).toBe(2);
    expect(existsSync(blobFile(HASH_ONLY_A))).toBe(true);
  });
});
