import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { afterAll, describe, expect, it } from "vitest";
import {
  CaptureStore,
  ImportBlockedError,
  ImportLimitError,
  JobStore,
  UnsafeImportPathError,
  XArchiveFormatError,
  commitXArchive,
  migrate,
  parseXArchive,
  previewXArchive,
  readXArchiveFile,
  type ParsedExport,
} from "./index.ts";

const T0 = 1_800_000_000_000;
const fixture = (name: string): string =>
  readXArchiveFile(fileURLToPath(new URL(`../../../fixtures/xarchive/${name}`, import.meta.url)));
const ACCOUNT = "x:account:1000000000000000001";
const ID100 = "1800000000000000100";

const setup = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const jobs = new JobStore(db);
  return { db, jobs, capture: new CaptureStore(db, jobs) };
};
type Ctx = ReturnType<typeof setup>;
const run = (c: Ctx, parsed: ParsedExport, owner = "A", nowMs = T0) =>
  commitXArchive(c.db, c.jobs, c.capture, parsed, { owner, nowMs });
const n = (db: Database.Database, sql: string): number =>
  (db.prepare(sql).get() as { n: number }).n;
const canonical = (db: Database.Database) =>
  Object.fromEntries(
    ["source", "source_version", "observation", "membership", "job"].map((t) => [
      t,
      db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
    ]),
  );
const exportOf = (bookmarks: unknown[], meta: Record<string, unknown> = {}): string =>
  JSON.stringify({
    export_metadata: {
      tool: "xarchive",
      schema_version: 2,
      user_id: "1000000000000000001",
      ...meta,
    },
    bookmarks,
  });

describe("xarchive parsing", () => {
  it("maps the legacy and schema 2 fixtures with string IDs and warnings", () => {
    const v1 = parseXArchive(fixture("v1-legacy.json"));
    expect(v1).toMatchObject({ schemaVersion: null, accountId: ACCOUNT });
    expect(v1.bookmarks[0]).toMatchObject({
      platformId: ID100,
      authorId: "x:user:1000000000000000002",
      authorHandle: "synth_author",
      publishedAt: "2026-07-30T12:00:00.000Z",
    });
    expect(v1.warnings.map((w) => w.code)).toContain("legacy-schema");
    const v2 = parseXArchive(fixture("v2-update.json"));
    expect(v2.schemaVersion).toBe(2);
    expect(v2.warnings.map((w) => w.code)).toContain("invalid-date");
  });

  it.each([
    ["future schema", exportOf([], { schema_version: 3 })],
    ["other tool", exportOf([], { tool: "something-else" })],
    ["not json", "{nope"],
    ["no bookmarks array", JSON.stringify({ export_metadata: {} })],
    ["numeric tweet_id", exportOf([{ tweet_id: 18000000000000, full_text: "x" }])],
    ["non-numeric tweet_id", exportOf([{ tweet_id: "../../etc/passwd", full_text: "x" }])],
    ["wrong text type", exportOf([{ tweet_id: "1", full_text: { a: 1 } }])],
    ["bad status", exportOf([{ tweet_id: "1", status: "weird" }])],
    ["bad folder ref", exportOf([{ tweet_id: "1", folder_ids: [1] }])],
  ])("rejects %s", (_name, json) => {
    expect(() => parseXArchive(json)).toThrow(XArchiveFormatError);
  });

  it("rejects archive bombs: size, count, text length, and nesting", () => {
    const limits = { maxBytes: 1000, maxBookmarks: 2, maxTextLength: 10, maxDepth: 8 };
    expect(() => parseXArchive(exportOf([], { pad: "x".repeat(2000) }), limits)).toThrow(
      ImportLimitError,
    );
    const three = [1, 2, 3].map((i) => ({ tweet_id: String(i), full_text: "a" }));
    expect(() => parseXArchive(exportOf(three), { ...limits, maxBytes: 1e6 })).toThrow(
      ImportLimitError,
    );
    expect(() =>
      parseXArchive(exportOf([{ tweet_id: "1", full_text: "x".repeat(11) }]), limits),
    ).toThrow(ImportLimitError);
    const deep = "[".repeat(100_000) + "]".repeat(100_000);
    expect(() => parseXArchive(`{"bookmarks":${deep}}`, { ...limits, maxBytes: 1e6 })).toThrow(
      ImportLimitError,
    );
    expect(nestingOk('["[[["]')).toBe(true);
  });

  it("drops invalid handles so no hostile URL is built, and keeps unknown dates unknown", () => {
    const p = parseXArchive(
      exportOf([
        {
          tweet_id: "5",
          full_text: "hi",
          created_at: "garbage",
          author: { screen_name: "evil/../x?y", user_id: "abc" },
        },
      ]),
    );
    expect(p.bookmarks[0]).toMatchObject({
      authorHandle: null,
      authorId: null,
      publishedAt: null,
    });
  });

  it("keeps the fullest record when an ID repeats in one file", () => {
    const p = parseXArchive(
      exportOf([
        { tweet_id: "9", full_text: "short" },
        { tweet_id: "9", full_text: "a much longer text" },
      ]),
    );
    expect(p.bookmarks).toHaveLength(1);
    expect(p.bookmarks[0]?.text).toBe("a much longer text");
  });
});

const nestingOk = (s: string): boolean => {
  parseXArchive(`{"bookmarks":[],"x":${JSON.stringify(s)}}`);
  return true;
};

describe("xarchive file paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "citspark-xa-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("rejects non-JSON, NUL, directory, and symlink sources", () => {
    const good = join(dir, "good.json");
    writeFileSync(good, exportOf([]));
    expect(readXArchiveFile(good)).toContain("bookmarks");
    writeFileSync(join(dir, "a.txt"), "{}");
    expect(() => readXArchiveFile(join(dir, "a.txt"))).toThrow(UnsafeImportPathError);
    expect(() => readXArchiveFile(`${good}\0.json`)).toThrow(UnsafeImportPathError);
    expect(() => readXArchiveFile("")).toThrow(UnsafeImportPathError);
    const link = join(dir, "link.json");
    try {
      symlinkSync(good, link);
      expect(() => readXArchiveFile(link)).toThrow(UnsafeImportPathError);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EPERM") throw e; // Windows without symlink rights
    }
  });

  it("refuses oversized files before reading them", () => {
    const big = join(dir, "big.json");
    writeFileSync(big, exportOf([], { pad: "x".repeat(500) }));
    expect(() =>
      readXArchiveFile(big, { maxBytes: 100, maxBookmarks: 1, maxTextLength: 1, maxDepth: 1 }),
    ).toThrow(ImportLimitError);
  });
});

describe("xarchive preview and commit", () => {
  it("previews without writing, with counts, mapping, warnings, and conflicts", () => {
    const c = setup();
    run(c, parseXArchive(fixture("v1-legacy.json")));
    const before = canonical(c.db);
    const preview = previewXArchive(c.db, parseXArchive(fixture("v2-update.json")));
    expect(canonical(c.db)).toEqual(before);
    expect(preview.writes).toBe(false);
    expect(preview.counts).toMatchObject({
      inFile: 3,
      new: 1,
      duplicates: 1,
      weakerSkipped: 1,
      toCommit: 2,
    });
    expect(preview.conflicts).toEqual([{ platformId: ID100, kind: "weaker-skipped" }]);
    expect(preview.mapping.length).toBeGreaterThan(0);
    expect(preview.blockers).toEqual([]);
  });

  it("commits through the shared path with import provenance", () => {
    const c = setup();
    const r = run(c, parseXArchive(fixture("v1-legacy.json")));
    expect(r).toMatchObject({ status: "imported", newSources: 2, newVersions: 2 });
    expect(n(c.db, "SELECT COUNT(*) n FROM membership")).toBe(2);
    expect(n(c.db, "SELECT COUNT(*) n FROM observation WHERE method = 'import'")).toBe(2);
    expect(c.jobs.get(r.jobId).state).toBe("complete");
    expect(c.capture.summary(r.jobId).adapters).toEqual(["xarchive-import@xarchive-schema-legacy"]);
  });

  it("is idempotent: importing the same file again writes nothing (T09)", () => {
    const c = setup();
    const parsed = parseXArchive(fixture("v2-update.json"));
    run(c, parsed);
    const after = canonical(c.db);
    expect(run(c, parseXArchive(fixture("v2-update.json")), "B", T0 + 1000).status).toBe(
      "already-imported",
    );
    expect(canonical(c.db)).toEqual(after);
    expect(previewXArchive(c.db, parsed).alreadyImported).toBe(true);
  });

  it("never replaces a fuller capture with a weaker import (T09)", () => {
    const c = setup();
    const full = "Full text of a captured post that is long enough to be truncated later.";
    const seed = (text: string, id = "77") =>
      parseXArchive(exportOf([{ tweet_id: id, full_text: text, status: "available" }]));
    run(c, seed(full));
    const stored = () =>
      c.db.prepare("SELECT text FROM source_version ORDER BY id").all() as { text: string }[];
    run(c, seed("Full text of a captured post that…"), "A", T0 + 1);
    run(
      c,
      parseXArchive(exportOf([{ tweet_id: "77", status: "unavailable", full_text: "" }], { x: 1 })),
      "A",
      T0 + 2,
    );
    expect(stored().map((r) => r.text)).toEqual([full]);
  });

  it("lets a complete text supersede a stored truncated copy", () => {
    const c = setup();
    const seed = (t: string, extra = {}) =>
      parseXArchive(exportOf([{ tweet_id: "66", full_text: t }], extra));
    run(c, seed("Great thread on caching…"));
    run(c, seed("Great thread on caching", { x: 1 }), "A", T0 + 1);
    expect(n(c.db, "SELECT COUNT(*) n FROM source_version")).toBe(2);
  });

  it("keeps a differing edit as an additional version and reports the conflict", () => {
    const c = setup();
    const seed = (t: string, extra = {}) =>
      parseXArchive(exportOf([{ tweet_id: "88", full_text: t }], extra));
    run(c, seed("original wording"));
    const p = previewXArchive(c.db, seed("entirely different wording", { x: 1 }));
    expect(p.conflicts).toEqual([{ platformId: "88", kind: "new-version" }]);
    run(c, seed("entirely different wording", { x: 1 }), "A", T0 + 1);
    expect(n(c.db, "SELECT COUNT(*) n FROM source_version")).toBe(2);
    expect(n(c.db, "SELECT COUNT(*) n FROM source")).toBe(1);
  });

  it("does not overwrite existing source metadata from a capture", () => {
    const c = setup();
    run(c, parseXArchive(fixture("v1-legacy.json")));
    const row = c.db.prepare("SELECT author_id FROM source WHERE platform_id = ?").get(ID100) as {
      author_id: string;
    };
    run(
      c,
      parseXArchive(
        exportOf([{ tweet_id: ID100, full_text: "Different.", author: { user_id: "5" } }], {
          x: 1,
        }),
      ),
      "A",
      T0 + 1,
    );
    expect(c.db.prepare("SELECT author_id FROM source WHERE platform_id = ?").get(ID100)).toEqual(
      row,
    );
  });

  it("refuses an account-less export and writes nothing", () => {
    const c = setup();
    const parsed = parseXArchive(
      exportOf([{ tweet_id: "1", full_text: "x" }], { user_id: "unknown" }),
    );
    expect(previewXArchive(c.db, parsed).blockers).toHaveLength(1);
    expect(() => run(c, parsed)).toThrow(ImportBlockedError);
    expect(n(c.db, "SELECT COUNT(*) n FROM job")).toBe(0);
  });

  it("resumes an interrupted import without duplicating records", () => {
    const c = setup();
    const many = Array.from({ length: 250 }, (_, i) => ({
      tweet_id: `19${String(i).padStart(17, "0")}`,
      full_text: `Synthetic ${i}`,
    }));
    const parsed = parseXArchive(exportOf(many));
    let pages = 0;
    expect(() =>
      commitXArchive(c.db, c.jobs, c.capture, parsed, {
        owner: "A",
        nowMs: T0,
        commitOptions: {
          onFaultPoint: (p) => {
            if (p === "before-commit" && ++pages === 2) throw new Error("crash");
          },
        },
      }),
    ).toThrow("crash");
    expect(n(c.db, "SELECT COUNT(*) n FROM source")).toBe(100);
    const r = run(c, parsed, "B", T0 + 120_000);
    expect(r.status).toBe("imported");
    expect(n(c.db, "SELECT COUNT(*) n FROM source")).toBe(250);
    expect(n(c.db, "SELECT COUNT(*) n FROM observation")).toBe(250);
  });
});
