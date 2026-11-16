// T07 (store part): trash excludes at once, survives restart, suppresses recapture; purge removes
// unshared derived data and keeps shared blobs (DAT-03, DAT-04, Q50). Synthetic data only.
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fsp from "node:fs/promises";
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
import type { MediaFs } from "./media.ts";

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

  it("refuses to purge while a running attempt holds one of the source's downloads", () => {
    const jobs = new JobStore(db);
    jobs.create({ id: "m", kind: "media" });
    const lease = jobs.acquire("m", "w", T0, 60_000);
    if (!lease) throw new Error("setup could not acquire the lease");
    db.prepare(
      "INSERT INTO media_download (source_id, url, state, claim_job_id, claim_generation, claim_token) VALUES (?, 'https://example.test/live.png', 'downloading', 'm', ?, ?)",
    ).run(A, lease.generation, "0123abcd-0000-4000-8000-000000000001");
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

// TRASH-01: linked enrichment already in flight when its parent is trashed or purged. Every
// linked persistence transaction re-checks the parent, so nothing of a purged parent returns.
describe("late linked persistence after the parent is purged (DAT-03, ENR-01)", () => {
  const gate = () => {
    let hit!: () => void;
    let release!: () => void;
    const reached = new Promise<void>((r) => (hit = r));
    const wait = new Promise<void>((r) => (release = r));
    return { hit, release, reached, wait };
  };
  const page = (url: string): LinkCapture => ({
    ok: true,
    finalUrl: url,
    chain: [url],
    httpStatus: 200,
    title: "Synthetic late",
    canonicalUrl: null,
    text: "synthetic late article",
    contentHash: "e".repeat(64),
    extractionMethod: "synthetic",
  });
  const URL_LATE = "https://example.test/late-article";
  const articles = () => n("SELECT 1 FROM source WHERE source_type = 'article'");
  const leftOf = (id: string) => ({
    refs: n("SELECT 1 FROM link_ref WHERE source_id = ?", id),
    edges: n("SELECT 1 FROM relationship WHERE from_id = ? OR to_id = ?", id, id),
    versions: n("SELECT 1 FROM source_version WHERE source_id = ?", id),
  });

  it("stores nothing for a parent purged while its capture was in flight", async () => {
    const g = gate();
    const linked = new LinkedSourceStore(db, async (url) => {
      g.hit();
      await g.wait;
      return page(url);
    });
    const work = linked.enrich(A, [{ url: URL_LATE, kind: "web" }]);
    await g.reached;
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    g.release();
    expect(await work).toEqual([
      { url: URL_LATE, status: "suppressed", sourceId: null, gapReason: null },
    ]);
    expect(t.status(A)).toBe("purged");
    expect(leftOf(A)).toEqual({ refs: 0, edges: 0, versions: 0 });
    expect(articles()).toBe(0);
    expect(n("SELECT 1 FROM linked_fetch WHERE original_url = ?", URL_LATE)).toBe(0);
  });

  it("records no gap or reference for a parent purged while its gap result was in flight", async () => {
    const g = gate();
    const linked = new LinkedSourceStore(db, async (url) => {
      g.hit();
      await g.wait;
      return {
        ok: false,
        reason: "paywall",
        detail: "synthetic gap",
        chain: [url],
        httpStatus: 402,
      };
    });
    const work = linked.enrich(A, [{ url: URL_LATE, kind: "web" }]);
    await g.reached;
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    g.release();
    expect(await work).toEqual([
      { url: URL_LATE, status: "suppressed", sourceId: null, gapReason: null },
    ]);
    expect(linked.gaps(A)).toEqual([]);
    expect(leftOf(A)).toEqual({ refs: 0, edges: 0, versions: 0 });
    expect(n("SELECT 1 FROM linked_fetch WHERE original_url = ?", URL_LATE)).toBe(0);
  });

  it("keeps one shared capture for a live joined parent and attaches only it", async () => {
    const g = gate();
    let calls = 0;
    const linked = new LinkedSourceStore(db, async (url) => {
      calls++;
      g.hit();
      await g.wait;
      return page(url);
    });
    const links = [{ url: URL_LATE, kind: "web" as const }];
    const a = linked.enrich(A, links);
    await g.reached;
    const b = linked.enrich(B, links);
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    g.release();
    const [outA, outB] = await Promise.all([a, b]);
    expect(calls).toBe(1);
    expect(outA).toEqual([
      { url: URL_LATE, status: "suppressed", sourceId: null, gapReason: null },
    ]);
    expect(outB).toHaveLength(1);
    expect(outB[0]).toMatchObject({ url: URL_LATE, status: "captured" });
    const article = outB[0]!.sourceId!;
    expect(t.status(article)).toBe("available");
    expect(articles()).toBe(1);
    expect(n("SELECT 1 FROM source_version WHERE source_id = ?", article)).toBe(1);
    expect(db.prepare("SELECT source_id FROM link_ref ORDER BY source_id").all()).toEqual([
      { source_id: B },
    ]);
    expect(
      db.prepare("SELECT from_id, to_id FROM relationship WHERE type = 'links_to'").all(),
    ).toEqual([{ from_id: B, to_id: article }]);
    expect(leftOf(A)).toEqual({ refs: 0, edges: 0, versions: 0 });
  });

  it("attaches no later link of the same call once the parent is trashed or purged", async () => {
    const SAVED = "article:saved";
    const HELD = "article:held";
    db.prepare("INSERT INTO source (id, source_type, canonical_url) VALUES (?, 'article', ?)").run(
      SAVED,
      "https://example.test/saved",
    );
    db.prepare("INSERT INTO source (id, source_type, canonical_url) VALUES (?, 'article', ?)").run(
      HELD,
      "https://example.test/held",
    );
    db.prepare(
      "INSERT INTO linked_fetch (original_url, gap_reason, gap_detail) VALUES ('https://example.test/known-gap', 'paywall', 'synthetic')",
    ).run();
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(HELD, T0);
    for (const stage of ["trash", "purge"] as const) {
      const g = gate();
      const linked = new LinkedSourceStore(db, async (url) => {
        g.hit();
        await g.wait;
        return page(url);
      });
      const parent = stage === "trash" ? A : B;
      const work = linked.enrich(parent, [
        { url: `${URL_LATE}/${stage}`, kind: "web" },
        { url: "https://example.test/saved", kind: "web" },
        { url: "https://example.test/known-gap", kind: "web" },
        { url: "https://example.test/held", kind: "web" },
        {
          url: "https://x.test/i/status/1800000000000000099",
          kind: "x_post",
          platformId: "1800000000000000099",
        },
      ]);
      await g.reached;
      t.trash(parent, T0);
      if (stage === "purge") t.purge(parent, T0);
      g.release();
      const out = await work;
      expect(out.map((o) => o.status)).toEqual(Array(5).fill("suppressed"));
      expect(out.every((o) => o.sourceId === null && o.gapReason === null)).toBe(true);
      expect(n("SELECT 1 FROM link_ref WHERE source_id = ?", parent)).toBe(0);
      expect(n("SELECT 1 FROM relationship WHERE from_id = ? AND type = 'links_to'", parent)).toBe(
        0,
      );
    }
    expect(
      n("SELECT 1 FROM linked_fetch WHERE original_url LIKE '%status/1800000000000000099'"),
    ).toBe(0);
    expect(n("SELECT 1 FROM relationship WHERE to_id IN (?, ?)", SAVED, HELD)).toBe(0);
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

// Attempt-isolated media downloads (media store migration 5: claim_token, part_file) racing trash
// and purge. Each test pauses a real execution attempt at one async file step, lets its lease
// expire or keeps it live, purges, then releases the step and lists every file left on disk.
describe("purge against attempt-isolated media downloads", () => {
  const BODY = Buffer.from("synthetic attempt-isolated media bytes");
  const H = createHash("sha256").update(BODY).digest("hex");
  const TTL = 60_000;
  const okFetch =
    (fetched: string[] = []): MediaFetch =>
    (url) => {
      fetched.push(url);
      return Promise.resolve(
        new Response(BODY, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(BODY.length),
            etag: '"v1"',
          },
        }),
      );
    };
  const gate = () => {
    let release!: () => void;
    let reached!: () => void;
    const released = new Promise<void>((r) => (release = r));
    const hit = new Promise<void>((r) => (reached = r));
    return { release, reached, released, hit };
  };
  const files = (): string[] => {
    const out: string[] = [];
    const walk = (rel: string): void => {
      const abs = join(dir, rel);
      if (!existsSync(abs)) return;
      for (const e of readdirSync(abs, { withFileTypes: true })) {
        const r = `${rel}/${e.name}`;
        if (e.isDirectory()) walk(r);
        else out.push(r);
      }
    };
    walk("tmp");
    walk("blobs");
    return out.sort();
  };
  const seededBlobs = [
    `blobs/${HASH_SHARED.slice(0, 2)}/${HASH_SHARED}`,
    `blobs/${HASH_ONLY_A.slice(0, 2)}/${HASH_ONLY_A}`,
  ].sort();
  const claim = (id: number) =>
    db
      .prepare(
        "SELECT state, error, claim_job_id, claim_token, part_file FROM media_download WHERE id = ?",
      )
      .get(id) as {
      state: string;
      error: string | null;
      claim_job_id: string | null;
      claim_token: string | null;
      part_file: string | null;
    };
  const store = (clock: { now: number }, fs: Partial<MediaFs> = {}, fetch = okFetch()) =>
    new MediaStore(db, {
      root: dir,
      budgetBytes: 1_000_000,
      minFreeBytes: 0,
      freeBytes: () => 10_000_000,
      fetch,
      now: () => clock.now,
      leaseTtlMs: TTL,
      fs,
    });
  const lease = (jobs: JobStore, id: string, now: number) => {
    jobs.create({ id, kind: "media" });
    const l = jobs.acquire(id, "w", now, TTL);
    if (!l) throw new Error("setup could not acquire the lease");
    return l;
  };

  it.each(["open", "write"] as const)(
    "an expired attempt paused at %s leaves no file once purge and the attempt settle",
    async (step) => {
      const clock = { now: T0 };
      const g = gate();
      const pause = async (): Promise<void> => {
        g.reached();
        await g.released;
      };
      const fs: Partial<MediaFs> =
        step === "open"
          ? { open: async (p, f) => (await pause(), fsp.open(p, f)) }
          : { write: async (h, c) => (await pause(), h.write(c)) };
      const media = store(clock, fs);
      const jobs = new JobStore(db);
      const l = lease(jobs, "m", T0);
      const d = media.enqueue(A, "https://example.test/a/paused.png");
      const run = media.download(d.id, { jobs, jobId: "m", lease: l });
      await g.hit;
      const held = claim(d.id);
      // The attempt holds an exclusive token and its own attempt-named part file.
      expect(held.claim_token).toMatch(/^[0-9a-f-]{36}$/);
      expect(held.part_file).toBe(`${d.id}.${held.claim_token}.part`);
      const own = `tmp/${held.part_file}`;
      expect(files()).toEqual(step === "open" ? seededBlobs : [...seededBlobs, own].sort());

      clock.now = T0 + TTL + 1; // the attempt's lease expires while its file step is in flight
      const t = new TrashStore(db, { mediaRoot: dir });
      t.trash(A, clock.now);
      expect(claim(d.id)).toMatchObject({
        state: "failed",
        error: "source_trashed",
        claim_job_id: null,
        claim_token: null,
        part_file: null,
      });
      expect(t.purge(A, clock.now).filesPending).toBe(0);
      expect(files()).toEqual([`blobs/${HASH_SHARED.slice(0, 2)}/${HASH_SHARED}`]);

      g.release();
      expect(await run).toBe("lease_lost");
      // Named paths after purge: the late open or write reached only the attempt's own file,
      // which the attempt removes when it ends; no blob was published.
      expect(existsSync(join(dir, own))).toBe(false);
      expect(existsSync(blobFile(H))).toBe(false);
      expect(files()).toEqual([`blobs/${HASH_SHARED.slice(0, 2)}/${HASH_SHARED}`]);
      expect(n("SELECT 1 FROM blob WHERE content_hash = ?", H)).toBe(0);
      expect(n("SELECT 1 FROM media WHERE source_id = ?", A)).toBe(0);
    },
  );

  it.each(["before", "after"] as const)(
    "an expired attempt paused %s its rename into blobs/ leaves no blob once purge runs",
    async (when) => {
      const clock = { now: T0 };
      const g = gate();
      const pause = async (): Promise<void> => {
        g.reached();
        await g.released;
      };
      const media = store(clock, {
        rename: async (from, to) => {
          const publish = to.endsWith(H);
          if (publish && when === "before") await pause();
          await fsp.rename(from, to);
          if (publish && when === "after") await pause();
        },
      });
      const jobs = new JobStore(db);
      const l = lease(jobs, "m", T0);
      const d = media.enqueue(A, "https://example.test/a/late.png");
      const run = media.download(d.id, { jobs, jobId: "m", lease: l });
      await g.hit; // verified and fenced; the rename is about to run or has just run
      const own = `tmp/${claim(d.id).part_file}`;
      const published = `blobs/${H.slice(0, 2)}/${H}`;
      expect(files()).toContain(when === "before" ? own : published);
      clock.now = T0 + TTL + 1;
      const t = new TrashStore(db, { mediaRoot: dir });
      t.trash(A, clock.now);
      t.purge(A, clock.now);
      // Named paths after purge: before the rename, purge removed the attempt's part file so the
      // late rename fails; after it, purge's sweep removed the unreferenced published file.
      expect(files()).toEqual([`blobs/${HASH_SHARED.slice(0, 2)}/${HASH_SHARED}`]);
      g.release();
      expect(await run).toBe("lease_lost");
      expect(files()).toEqual([`blobs/${HASH_SHARED.slice(0, 2)}/${HASH_SHARED}`]);
      expect(n("SELECT 1 FROM blob WHERE content_hash = ?", H)).toBe(0);
      expect(n("SELECT 1 FROM media WHERE content_hash = ?", H)).toBe(0);
    },
  );

  it("defers removing a late-published orphan while another attempt is live, then removes it", async () => {
    const clock = { now: T0 };
    const g = gate();
    const media = store(clock, {
      rename: async (from, to) => {
        await fsp.rename(from, to);
        if (to.endsWith(H)) {
          g.reached();
          await g.released;
        }
      },
    });
    const jobs = new JobStore(db);
    const l = lease(jobs, "m", T0);
    const d = media.enqueue(A, "https://example.test/a/late.png");
    const run = media.download(d.id, { jobs, jobId: "m", lease: l });
    await g.hit;
    clock.now = T0 + TTL + 1;
    // Another source's attempt is running under a live lease.
    const other = lease(jobs, "mb", clock.now);
    db.prepare(
      "INSERT INTO media_download (source_id, url, state, claim_job_id, claim_generation, claim_token) VALUES (?, 'https://example.test/b/live.png', 'downloading', 'mb', ?, ?)",
    ).run(B, other.generation, "0123abcd-0000-4000-8000-00000000cafe");
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, clock.now);
    t.purge(A, clock.now);
    const orphan = `blobs/${H.slice(0, 2)}/${H}`;
    expect(files()).toEqual(
      [`blobs/${HASH_SHARED.slice(0, 2)}/${HASH_SHARED}`, `blobs/bb/${HASH_ONLY_A}`, orphan].sort(),
    );
    g.release();
    expect(await run).toBe("lease_lost");
    db.prepare("UPDATE media_download SET claim_token = NULL WHERE source_id = ?").run(B);
    expect(t.retryPendingFiles(clock.now)).toEqual({ removed: 2, pending: 0 });
    expect(files()).toEqual([`blobs/${HASH_SHARED.slice(0, 2)}/${HASH_SHARED}`]);
  });

  it("never deletes a blob another source's live attempt has just published for the same bytes", async () => {
    // A's media has the same content as B's download, but A's file is missing, so B publishes
    // its own verified file by rename and commits afterwards.
    db.prepare("INSERT INTO blob (content_hash, size_bytes, ref_count) VALUES (?, ?, 1)").run(
      H,
      BODY.length,
    );
    db.prepare(
      "INSERT INTO media (source_id, content_hash, blob_path, mime_type) VALUES (?, ?, ?, 'image/png')",
    ).run(A, H, `blobs/${H.slice(0, 2)}/${H}`);
    const clock = { now: T0 };
    const g = gate();
    const media = store(clock, {
      rename: async (from, to) => {
        await fsp.rename(from, to);
        if (to.includes(`${H.slice(0, 2)}`) && to.endsWith(H)) {
          g.reached();
          await g.released;
        }
      },
    });
    const jobs = new JobStore(db);
    const l = lease(jobs, "mb", T0);
    const d = media.enqueue(B, "https://example.test/b/same.png");
    const run = media.download(d.id, { jobs, jobId: "mb", lease: l });
    await g.hit; // B's blob file exists; B's blob/media rows are not committed yet
    expect(existsSync(blobFile(H))).toBe(true);
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0 + 1);
    const r = t.purge(A, T0 + 1);
    expect(r.blobsRemoved).toContain(H);
    // B's live attempt may still reference these bytes: every blob removal stays queued.
    expect(existsSync(blobFile(H))).toBe(true);
    expect(existsSync(blobFile(HASH_ONLY_A))).toBe(true);
    expect(r.filesPending).toBe(2);
    g.release();
    expect(await run).toBe("complete");
    expect(existsSync(blobFile(H))).toBe(true);
    expect(media.blob(H)).toMatchObject({ refCount: 1 });
    expect(n("SELECT 1 FROM media WHERE source_id = ? AND content_hash = ?", B, H)).toBe(1);
    // The authoritative rows now reference the blob, so its queued removal is dropped; A's
    // unshared blob is removed now that no attempt is running.
    expect(t.retryPendingFiles(T0 + 2)).toEqual({ removed: 1, pending: 0 });
    expect(existsSync(blobFile(HASH_ONLY_A))).toBe(false);
    expect(existsSync(blobFile(H))).toBe(true);
    expect(n("SELECT 1 FROM purge_file")).toBe(0);
  });

  it("stops a cleanly ended attempt's entry on trash even while its job lease is live", async () => {
    const clock = { now: T0 };
    const fetched: string[] = [];
    let fail = true;
    const ok = okFetch(fetched);
    const media = store(clock, {}, (url, init) =>
      fail ? Promise.reject(new Error("synthetic network down")) : ok(url, init),
    );
    const jobs = new JobStore(db);
    const l = lease(jobs, "m", T0);
    const d = media.enqueue(A, "https://example.test/a/retry.png");
    expect(await media.download(d.id, { jobs, jobId: "m", lease: l })).toBe("interrupted");
    // The attempt ended (token released) but its job still holds a live lease.
    expect(claim(d.id)).toMatchObject({ state: "pending", claim_job_id: "m", claim_token: null });
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0 + 1);
    expect(claim(d.id)).toMatchObject({ state: "failed", error: "source_trashed" });
    fail = false;
    clock.now = T0 + TTL + 1;
    jobs.create({ id: "m2", kind: "media" });
    await media.runJob(jobs, "m2", "w");
    expect(fetched).toEqual([]);
    // No attempt is running, so purge is not busy.
    expect(t.purge(A, T0 + 2).sourceId).toBe(A);
    expect(files()).toEqual([`blobs/${HASH_SHARED.slice(0, 2)}/${HASH_SHARED}`]);
  });

  it("keeps a job from retrying its own failed download of a trashed source", async () => {
    const clock = { now: T0 };
    const fetched: string[] = [];
    const media = store(clock, {}, okFetch(fetched));
    const jobs = new JobStore(db);
    jobs.create({ id: "m", kind: "media" });
    // Job m failed this entry earlier and owns the failure, so its next run would retry it.
    db.prepare(
      "INSERT INTO media_download (source_id, url, state, error, claim_job_id, claim_generation) VALUES (?, 'https://example.test/a/404.png', 'failed', 'http 404', 'm', 0)",
    ).run(A);
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    await media.runJob(jobs, "m", "w");
    expect(fetched).toEqual([]);
    expect(n("SELECT 1 FROM media WHERE content_hash = ?", H)).toBe(0);
  });

  it("removes an attempt-named part file and the recorded part of a sealed attempt", () => {
    const tok = "0123abcd-0000-4000-8000-00000000beef";
    const id = Number(
      db
        .prepare(
          "INSERT INTO media_download (source_id, url, state, bytes_received) VALUES (?, 'https://example.test/v.mp4', 'pending', 3)",
        )
        .run(A).lastInsertRowid,
    );
    db.prepare("UPDATE media_download SET part_file = ? WHERE id = ?").run(`${id}.${tok}.part`, id);
    mkdirSync(join(dir, "tmp"), { recursive: true });
    writeFileSync(join(dir, "tmp", `${id}.${tok}.part`), "abc");
    // A stale attempt's file of the same entry, and another entry's file that must stay.
    writeFileSync(join(dir, "tmp", `${id}.ffffffff-0000-4000-8000-000000000000.part`), "x");
    writeFileSync(join(dir, "tmp", `${id + 1}.${tok}.part`), "keep");
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    t.purge(A, T0);
    expect(readdirSync(join(dir, "tmp"))).toEqual([`${id + 1}.${tok}.part`]);
    expect(claim(id)).toMatchObject({ part_file: null, claim_token: null });
  });

  it("removes a purged-only blob whose reference count drifted upward", () => {
    db.prepare("UPDATE blob SET ref_count = 5 WHERE content_hash = ?").run(HASH_ONLY_A);
    const t = new TrashStore(db, { mediaRoot: dir });
    t.trash(A, T0);
    expect(t.purge(A, T0).blobsRemoved).toEqual([HASH_ONLY_A]);
    expect(existsSync(blobFile(HASH_ONLY_A))).toBe(false);
    expect(existsSync(blobFile(HASH_SHARED))).toBe(true);
  });

  it("keeps a queued blob file that a media row still names without a blob row", () => {
    let fail = true;
    const t = new TrashStore(db, {
      mediaRoot: dir,
      removeFile: (p) => {
        if (fail) throw Object.assign(new Error("EACCES: synthetic"), { code: "EACCES" });
        rmSync(p, { force: true });
      },
    });
    t.trash(A, T0);
    expect(t.purge(A, T0).filesPending).toBe(1);
    // A legacy media row (predating the blob table) names the same content.
    db.prepare("INSERT INTO media (source_id, content_hash, blob_path) VALUES (?, ?, ?)").run(
      B,
      HASH_ONLY_A,
      `blobs/${HASH_ONLY_A.slice(0, 2)}/${HASH_ONLY_A}`,
    );
    fail = false;
    expect(t.retryPendingFiles()).toEqual({ removed: 0, pending: 0 });
    expect(existsSync(blobFile(HASH_ONLY_A))).toBe(true);
  });
});
