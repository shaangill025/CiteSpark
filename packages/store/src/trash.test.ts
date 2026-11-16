// T07 (store part): trash excludes at once, survives restart, suppresses recapture; purge removes
// unshared derived data and keeps shared blobs (DAT-03, DAT-04, Q50). Synthetic data only.
import Database from "better-sqlite3";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CaptureStore,
  JobStore,
  LinkedSourceStore,
  MediaStore,
  NotTrashedError,
  PurgeBusyError,
  PurgedSourceError,
  TrashStore,
  UnknownSourceError,
  migrate,
  type CapturePage,
  type LinkCapture,
  type MediaFetch,
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
    for (const table of ["media", "annotation", "observation", "membership"]) {
      expect(n(`SELECT 1 FROM ${table} WHERE source_id = ?`, A)).toBe(0);
    }
    // The download stays as a suppressed tombstone so its id and URL are never reused.
    expect(
      db
        .prepare(
          "SELECT state, error, media_id, bytes_received FROM media_download WHERE source_id = ?",
        )
        .all(A),
    ).toEqual([{ state: "failed", error: "source_purged", media_id: null, bytes_received: 0 }]);
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
      canonical_url: "https://example.test/p", // identity kept for recapture suppression
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

// Regressions from the PR #16 review and the linked-sources integration. Synthetic data only.
describe("purge integrity", () => {
  const C = "x_post:1800000000000000003";
  const partFile = (id: number): string => join(dir, "tmp", `${id}.part`);
  const versionOf = (src: string): number =>
    (db.prepare("SELECT id FROM source_version WHERE source_id = ?").get(src) as { id: number }).id;

  it("removes relationships between other sources that cite the purged source's version", () => {
    db.prepare("INSERT INTO source (id, source_type, platform_id) VALUES (?, 'x_post', '3')").run(
      C,
    );
    db.prepare(
      "INSERT INTO relationship (from_id, to_id, type, version_id, origin) VALUES (?, ?, 'quotes', ?, 'captured')",
    ).run(B, C, versionOf(A));
    db.prepare(
      "INSERT INTO relationship (from_id, to_id, type, origin) VALUES (?, ?, 'replies', 'captured')",
    ).run(B, C);
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    expect(t.status(A)).toBe("purged");
    expect(db.prepare("SELECT from_id, to_id, type FROM relationship").all()).toEqual([
      { from_id: B, to_id: C, type: "replies" },
    ]);
  });

  it("never deletes a blob that another source's media still references", () => {
    const media = new MediaStore(db, {
      root: dir,
      budgetBytes: 1_000_000,
      minFreeBytes: 0,
      freeBytes: () => 10_000_000,
      fetch: () => Promise.reject(new Error("no network in this test")),
    });
    media.release(HASH_SHARED); // a stray release leaves 1 counted reference for 2 media rows
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    expect(t.purge(A, T0).blobsRemoved).toEqual([HASH_ONLY_A]);
    expect(existsSync(blobFile(HASH_SHARED))).toBe(true);
    expect(media.blob(HASH_SHARED)?.refCount).toBe(1);
    expect(n("SELECT 1 FROM media WHERE source_id = ? AND content_hash = ?", B, HASH_SHARED)).toBe(
      1,
    );
  });

  it("queues file removals that fail after commit and retries them, also after restart", () => {
    let fail = true;
    const removeFile = (path: string): void => {
      if (fail) throw Object.assign(new Error("EACCES: synthetic"), { code: "EACCES" });
      rmSync(path, { force: true });
    };
    const t = new TrashStore(db, { mediaRoot: dir, removeFile });
    t.trash(A, T0);
    const r = t.purge(A, T0);
    expect(t.status(A)).toBe("purged");
    expect(r.filesPending).toBe(1);
    expect(existsSync(blobFile(HASH_ONLY_A))).toBe(true);
    // A second purge of the same source still retries the queued removal.
    expect(t.purge(A, T0).filesPending).toBe(1);
    db.close();
    db = open();
    fail = false;
    const after = new TrashStore(db, { mediaRoot: dir, removeFile });
    expect(after.retryPendingFiles()).toEqual({ removed: 1, pending: 0 });
    expect(existsSync(blobFile(HASH_ONLY_A))).toBe(false);
    expect(existsSync(blobFile(HASH_SHARED))).toBe(true);
    expect(after.retryPendingFiles()).toEqual({ removed: 0, pending: 0 });
  });

  it("removes partial download files and never reuses a purged download id", () => {
    const pid = Number(
      db
        .prepare(
          "INSERT INTO media_download (source_id, url, state, bytes_received) VALUES (?, 'https://example.test/v.mp4', 'paused_budget', 3)",
        )
        .run(A).lastInsertRowid,
    );
    mkdirSync(join(dir, "tmp"), { recursive: true });
    writeFileSync(partFile(pid), "abc");
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    expect(existsSync(partFile(pid))).toBe(false);
    const media = new MediaStore(db, {
      root: dir,
      budgetBytes: 1_000_000,
      minFreeBytes: 0,
      freeBytes: () => 10_000_000,
      fetch: () => Promise.reject(new Error("no network in this test")),
    });
    const next = media.enqueue(B, "https://example.test/new.png");
    expect(next.id).toBeGreaterThan(pid);
    // Re-enqueueing the purged source's media is suppressed, not a new download.
    expect(media.enqueue(A, "https://example.test/v.mp4")).toMatchObject({
      sourceId: A,
      state: "failed",
      bytesReceived: 0,
    });
    expect(media.usedBytes()).toBe(3); // the shared blob only; the partial no longer counts
  });

  it("refuses to purge while a live job holds one of the source's downloads", () => {
    const jobs = new JobStore(db);
    jobs.create({ id: "m", kind: "media" });
    const lease = jobs.acquire("m", "w", T0, 60_000);
    if (!lease) throw new Error("setup could not acquire the lease");
    db.prepare(
      "INSERT INTO media_download (source_id, url, state, claim_job_id, claim_generation) VALUES (?, 'https://example.test/live.png', 'downloading', 'm', ?)",
    ).run(A, lease.generation);
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    expect(() => t.purge(A, T0 + 1)).toThrow(PurgeBusyError);
    expect(t.status(A)).toBe("trashed");
    expect(n("SELECT 1 FROM media WHERE source_id = ?", A)).toBe(2);
    expect(t.emptyTrash(T0 + 1)).toMatchObject({ purged: [], busy: [A] });
    // Once the lease has expired the claim is stale and purge proceeds.
    expect(t.purge(A, T0 + 120_000).sourceId).toBe(A);
    expect(t.status(A)).toBe("purged");
  });
});

describe("sync binding unlink (SYN-04, Q51)", () => {
  const binding = () =>
    db
      .prepare(
        "SELECT state, suppression, last_common_hash, hex(base_content) base FROM sync_binding WHERE note_id = 'n'",
      )
      .get();

  it("unlinks and suppresses the vault note on trash, across restart and restore", () => {
    db.prepare("UPDATE sync_binding SET base_content = x'01'").run();
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    expect(binding()).toEqual({
      state: "unlinked",
      suppression: "unlinked",
      last_common_hash: "h",
      base: "01",
    });
    db.close();
    db = open();
    expect(binding()).toMatchObject({ state: "unlinked", suppression: "unlinked" });
    // Restoring the source does not rebind the note; binding restoration is explicit (SYN-04).
    new TrashStore(db, { mediaRoot: dir }).restore(A);
    expect(binding()).toMatchObject({ state: "unlinked", suppression: "unlinked" });
  });

  it("keeps a stronger suppression and drops library-side note content on purge", () => {
    const vaultNote = join(dir, "vault", "Notes", "a.md");
    mkdirSync(join(dir, "vault", "Notes"), { recursive: true });
    writeFileSync(vaultNote, "synthetic vault copy");
    db.prepare(
      "INSERT INTO sync_conflict (library_id, vault_id, note_id, kind, library_text) VALUES ('l', 'v', 'n', 'merge', 'synthetic')",
    ).run();
    db.prepare("UPDATE sync_binding SET base_content = x'01', last_written_hash = 'w'").run();
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    expect(
      db
        .prepare(
          "SELECT state, suppression, last_common_hash, base_content, last_written_hash, path FROM sync_binding",
        )
        .get(),
    ).toEqual({
      state: "unlinked",
      suppression: "deleted",
      last_common_hash: null,
      base_content: null,
      last_written_hash: null,
      path: "Notes/a.md",
    });
    expect(n("SELECT 1 FROM sync_conflict")).toBe(0);
    // Vault files are separate copies and are never erased by trash or purge (DAT-04).
    expect(readFileSync(vaultNote, "utf8")).toBe("synthetic vault copy");
  });
});

describe("recapture suppression", () => {
  const capturePage = (id: string, records: CapturePage["records"]) => {
    const jobs = new JobStore(db);
    const capture = new CaptureStore(db, jobs);
    jobs.create({ id, kind: "capture", accountId: "acct", collectionId: "col" });
    const lease = jobs.acquire(id, "o", T0, 60_000);
    if (!lease) throw new Error("setup could not acquire the lease");
    return capture.commitPage(id, lease, T0, {
      passId: "p1",
      accountId: "acct",
      collectionId: "col",
      cursorIn: null,
      cursorOut: null,
      adapter: { id: "synthetic", version: "1" },
      records,
    });
  };

  it("persists after purge and lifts on restore of a trashed source", () => {
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    t.trash(B, T0);
    capturePage("j1", [
      { sourceType: "x_post", platformId: "1800000000000000001", text: "again" },
      { sourceType: "x_post", platformId: "1800000000000000002", text: "again" },
    ]);
    expect(n("SELECT 1 FROM source_version WHERE source_id IN (?, ?)", A, B)).toBe(1);
    expect(
      n("SELECT 1 FROM source WHERE platform_id IN ('1800000000000000001', '1800000000000000002')"),
    ).toBe(2);
    t.restore(B);
    capturePage("j2", [{ sourceType: "x_post", platformId: "1800000000000000002", text: "again" }]);
    expect(n("SELECT 1 FROM source_version WHERE source_id = ?", B)).toBe(2);
    expect(n("SELECT 1 FROM source_version WHERE source_id = ?", A)).toBe(0);
  });

  it("suppresses media downloads of a trashed source until it is restored", async () => {
    const fetched: string[] = [];
    const body = Buffer.from("synthetic media");
    const fetchStub: MediaFetch = (url) => {
      fetched.push(url);
      return Promise.resolve(
        new Response(body, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(body.length),
            etag: '"v1"',
          },
        }),
      );
    };
    let now = T0;
    const media = new MediaStore(db, {
      root: dir,
      budgetBytes: 1_000_000,
      minFreeBytes: 0,
      freeBytes: () => 10_000_000,
      fetch: fetchStub,
      now: () => (now += 1),
    });
    const jobs = new JobStore(db);
    const before = media.enqueue(A, "https://example.test/before.png");
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    const during = media.enqueue(A, "https://example.test/during.png");
    jobs.create({ id: "m1", kind: "media" });
    await media.runJob(jobs, "m1", "w");
    expect(fetched).toEqual([]);
    expect(media.getDownload(before.id).state).not.toBe("complete");
    expect(media.getDownload(during.id).state).not.toBe("complete");
    t.restore(A);
    jobs.create({ id: "m2", kind: "media" });
    expect(await media.runJob(jobs, "m2", "w")).toBe("complete");
    expect(fetched.sort()).toEqual([
      "https://example.test/before.png",
      "https://example.test/during.png",
    ]);
  });
});

describe("linked sources (ENR-01 with DAT-03)", () => {
  const ARTICLE = "article:synthetic";
  const CANON = "https://example.test/canon";
  const ok = (finalUrl: string, title = "Synthetic"): LinkCapture => ({
    ok: true,
    finalUrl,
    chain: [finalUrl],
    httpStatus: 200,
    title,
    canonicalUrl: CANON,
    text: "synthetic article",
    contentHash: "c".repeat(64),
    extractionMethod: "synthetic",
  });
  const articles = () => n("SELECT 1 FROM source WHERE source_type = 'article'");

  it("does not recapture a trashed article reached through another URL or a trashed X post", async () => {
    db.prepare("INSERT INTO source (id, source_type, canonical_url) VALUES (?, 'article', ?)").run(
      ARTICLE,
      CANON,
    );
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(ARTICLE, T0);
    t.trash(A, T0);
    const fetched: string[] = [];
    const linked = new LinkedSourceStore(db, (url) => {
      fetched.push(url);
      return Promise.resolve(ok(CANON));
    });
    const out = await linked.enrich(B, [
      { url: "https://example.test/short", kind: "web" },
      {
        url: "https://x.test/i/status/1800000000000000001",
        kind: "x_post",
        platformId: "1800000000000000001",
      },
    ]);
    expect(out.map((o) => [o.status, o.sourceId])).toEqual([
      ["suppressed", ARTICLE],
      ["suppressed", A],
    ]);
    expect(n("SELECT 1 FROM source WHERE canonical_url = ?", CANON)).toBe(1);
    expect(n("SELECT 1 FROM source_version WHERE source_id = ?", ARTICLE)).toBe(0);
    expect(n("SELECT 1 FROM linked_fetch WHERE gap_reason = 'x_post_not_saved'")).toBe(0);
    expect(articles()).toBe(1);
  });

  it("keeps a purged article suppressed and unavailable without new relationships", async () => {
    db.prepare("INSERT INTO source (id, source_type, canonical_url) VALUES (?, 'article', ?)").run(
      ARTICLE,
      CANON,
    );
    const linked = new LinkedSourceStore(db, () => Promise.resolve(ok(CANON, "Secret title")));
    await linked.enrich(B, [{ url: CANON, kind: "web" }]);
    expect(n("SELECT 1 FROM relationship WHERE to_id = ?", ARTICLE)).toBe(1);
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(ARTICLE, T0);
    t.purge(ARTICLE, T0);
    expect(db.prepare("SELECT source_id, title, content_hash FROM linked_fetch").get()).toEqual({
      source_id: ARTICLE,
      title: null,
      content_hash: null,
    });
    const again = await linked.enrich(A, [
      { url: CANON, kind: "web" },
      { url: "https://example.test/other-path", kind: "web" },
    ]);
    expect(again.map((o) => [o.status, o.sourceId])).toEqual([
      ["suppressed", ARTICLE],
      ["suppressed", ARTICLE],
    ]);
    expect(t.status(ARTICLE)).toBe("purged");
    expect(n("SELECT 1 FROM relationship WHERE to_id = ?", ARTICLE)).toBe(0);
    expect(n("SELECT 1 FROM source_version WHERE source_id = ?", ARTICLE)).toBe(0);
    expect(articles()).toBe(1);
  });

  it("removes the purged source's link references and unshared gaps, keeping shared rows", async () => {
    const gap = (url: string): LinkCapture => ({
      ok: false,
      reason: "paywall",
      detail: "synthetic",
      chain: [url],
      httpStatus: 402,
    });
    const linked = new LinkedSourceStore(db, (url) =>
      Promise.resolve(url.endsWith("/art") ? ok(url) : gap(url)),
    );
    await linked.enrich(A, [
      { url: "https://example.test/only-a", kind: "web" },
      { url: "https://example.test/shared", kind: "web" },
      { url: "https://example.test/art", kind: "web" },
    ]);
    await linked.enrich(B, [{ url: "https://example.test/shared", kind: "web" }]);
    const article = (
      db.prepare("SELECT source_id FROM linked_fetch WHERE original_url LIKE '%/art'").get() as {
        source_id: string;
      }
    ).source_id;
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    expect(n("SELECT 1 FROM link_ref WHERE source_id = ?", A)).toBe(0);
    expect(db.prepare("SELECT original_url FROM linked_fetch ORDER BY original_url").all()).toEqual(
      [
        { original_url: "https://example.test/art" },
        { original_url: "https://example.test/shared" },
      ],
    );
    expect(linked.gaps(B).map((g) => g.url)).toEqual(["https://example.test/shared"]);
    // The linked article is its own source and stays available.
    expect(t.status(article)).toBe("available");
    expect(n("SELECT 1 FROM source_version WHERE source_id = ?", article)).toBe(1);
  });
});

describe("T07 end to end (synthetic)", () => {
  it("trash, suppressed recapture, and purge keep shared blobs and linked sources intact", async () => {
    const body = Buffer.from("synthetic shared media bytes");
    const fetchStub: MediaFetch = () =>
      Promise.resolve(
        new Response(body, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": String(body.length) },
        }),
      );
    let now = T0;
    const media = new MediaStore(db, {
      root: dir,
      budgetBytes: 1_000_000,
      minFreeBytes: 0,
      freeBytes: () => 10_000_000,
      fetch: fetchStub,
      now: () => (now += 1),
    });
    const jobs = new JobStore(db);
    media.enqueue(A, "https://example.test/a/shared.png");
    media.enqueue(B, "https://example.test/b/shared.png");
    jobs.create({ id: "m", kind: "media" });
    expect(await media.runJob(jobs, "m", "w")).toBe("complete");
    const hash = (
      db
        .prepare(
          "SELECT content_hash FROM media WHERE source_id = ? AND mime_type = 'image/png' ORDER BY id DESC",
        )
        .get(B) as {
        content_hash: string;
      }
    ).content_hash;
    expect(media.blob(hash)?.refCount).toBe(2);
    const linked = new LinkedSourceStore(db, (url) =>
      Promise.resolve({
        ok: true,
        finalUrl: url,
        chain: [url],
        httpStatus: 200,
        title: "Synthetic",
        canonicalUrl: null,
        text: "synthetic linked article",
        contentHash: "d".repeat(64),
        extractionMethod: "synthetic",
      }),
    );
    const [art] = await linked.enrich(A, [{ url: "https://example.test/linked", kind: "web" }]);
    await linked.enrich(B, [{ url: "https://example.test/linked", kind: "web" }]);

    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, now);
    expect(n("SELECT 1 FROM active_source WHERE id = ?", A)).toBe(0);
    const capture = new CaptureStore(db, jobs);
    jobs.create({ id: "c", kind: "capture", accountId: "acct", collectionId: "col" });
    const lease = jobs.acquire("c", "o", now, 60_000);
    if (!lease) throw new Error("setup could not acquire the lease");
    capture.commitPage("c", lease, now, {
      passId: "p",
      accountId: "acct",
      collectionId: "col",
      cursorIn: null,
      cursorOut: null,
      adapter: { id: "synthetic", version: "1" },
      records: [{ sourceType: "x_post", platformId: "1800000000000000001", text: "recaptured" }],
    });
    expect(n("SELECT 1 FROM source_version WHERE source_id = ?", A)).toBe(1);

    db.close();
    db = open();
    const after = new TrashStore(db, { mediaRoot: dir });
    expect(after.purge(A, now + 1).filesPending).toBe(0);
    expect(existsSync(blobFile(hash))).toBe(true);
    expect(
      (
        db.prepare("SELECT ref_count FROM blob WHERE content_hash = ?").get(hash) as {
          ref_count: number;
        }
      ).ref_count,
    ).toBe(1);
    expect(after.status(art!.sourceId!)).toBe("available");
    expect(n("SELECT 1 FROM link_ref WHERE source_id = ?", B)).toBe(1);
    expect(n("SELECT 1 FROM relationship WHERE from_id = ? AND to_id = ?", B, art!.sourceId)).toBe(
      1,
    );

    after.trash(B, now + 2);
    after.purge(B, now + 3);
    expect(existsSync(blobFile(hash))).toBe(false);
    expect(n("SELECT 1 FROM blob WHERE content_hash = ?", hash)).toBe(0);
    expect(after.status(art!.sourceId!)).toBe("available");
    expect(n("SELECT 1 FROM purge_file")).toBe(0);
  });
});
