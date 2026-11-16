import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  CaptureStore,
  JobStore,
  commitXArchive,
  isWeakerText,
  migrate,
  parseXArchive,
  previewXArchive,
  readXArchiveFile,
  type CommitImportOptions,
  type ParsedExport,
} from "./index.ts";

/**
 * Review regressions for xarchive import quality ordering (R1) and unavailable-bookmark evidence
 * (R2, R3): MIG-01, T09, Q37, CAP-02. All data is synthetic.
 */

const T0 = 1_800_000_000_000;
const OWNER = "1000000000000000001";
const OTHER = "1000000000000000009";
const ACCOUNT = `x:account:${OWNER}`;
const OTHER_ACCOUNT = `x:account:${OTHER}`;
const ID100 = "1800000000000000100";

const setup = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const jobs = new JobStore(db);
  return { db, jobs, capture: new CaptureStore(db, jobs) };
};
type Ctx = ReturnType<typeof setup>;
const run = (c: Ctx, parsed: ParsedExport, nowMs = T0, extra: Partial<CommitImportOptions> = {}) =>
  commitXArchive(c.db, c.jobs, c.capture, parsed, { owner: "A", clock: () => nowMs, ...extra });
const n = (c: Ctx, sql: string): number => (c.db.prepare(sql).get() as { n: number }).n;
const exportOf = (bookmarks: unknown[], meta: Record<string, unknown> = {}): ParsedExport =>
  parseXArchive(
    JSON.stringify({
      export_metadata: { tool: "xarchive", schema_version: 2, user_id: OWNER, ...meta },
      bookmarks,
    }),
  );
const texts = (c: Ctx): string[] =>
  (c.db.prepare("SELECT text FROM source_version ORDER BY id").all() as { text: string }[]).map(
    (r) => r.text,
  );
const canonical = (c: Ctx) =>
  Object.fromEntries(
    ["source", "source_version", "observation", "membership", "job"].map((t) => [
      t,
      c.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
    ]),
  );
interface ObsRow {
  account: string;
  availability: string;
  method: string;
  text: string;
  evidence: string | null;
}
const observations = (c: Ctx): ObsRow[] =>
  c.db
    .prepare(
      `SELECT j.account_id account, o.availability, o.method, v.text, o.evidence
       FROM observation o JOIN job j ON j.id = o.job_id JOIN source_version v ON v.id = o.version_id
       ORDER BY o.id`,
    )
    .all() as ObsRow[];
const evidenceOf = (o: ObsRow): unknown => (o.evidence === null ? null : JSON.parse(o.evidence));
const fixture = (name: string): ParsedExport =>
  parseXArchive(
    readXArchiveFile(fileURLToPath(new URL(`../../../fixtures/xarchive/${name}`, import.meta.url))),
  );

describe("R1: content-aware text quality ordering", () => {
  it("treats an ellipsis-marked truncation as weaker than its complete text", () => {
    expect(isWeakerText("abc...", ["abcd"])).toBe(true);
    expect(isWeakerText("abc…", ["abcd"])).toBe(true);
    expect(isWeakerText("abc", ["abcd"])).toBe(true);
    expect(isWeakerText("abc…", ["abcdefghij…"])).toBe(true);
    expect(isWeakerText("abc...", ["abc"])).toBe(true);
    expect(isWeakerText("", ["abcd"])).toBe(true);
  });

  it("never ranks a truncation above the complete text it abbreviates, or a distinct text as weaker", () => {
    expect(isWeakerText("abcd", ["abc..."])).toBe(false);
    expect(isWeakerText("abcd", ["abc…"])).toBe(false);
    expect(isWeakerText("abc", ["abc…"])).toBe(false);
    expect(isWeakerText("abcd", ["abcd"])).toBe(false);
    expect(isWeakerText("abxy", ["abcd"])).toBe(false);
    expect(isWeakerText("abcd", ["abxy"])).toBe(false);
    expect(isWeakerText("", [""])).toBe(false);
    expect(isWeakerText("abc", [""])).toBe(false);
  });

  for (const order of [
    ["abcd", "abc..."],
    ["abc...", "abcd"],
    ["abcd", "abc…"],
    ["abc…", "abcd"],
  ]) {
    it(`keeps the complete text of an in-file duplicate (${order.join(" then ")})`, () => {
      const p = exportOf(order.map((t) => ({ tweet_id: "1", full_text: t })));
      expect(p.bookmarks.map((b) => b.text)).toEqual(["abcd"]);
      expect(p.warnings.find((w) => w.code === "duplicate-in-file")?.count).toBe(1);
      expect(p.warnings.map((w) => w.code)).not.toContain("duplicate-distinct-versions");
    });
  }

  it("keeps distinct complete texts of one in-file ID as versions and warns explicitly", () => {
    for (const order of [
      ["first wording", "second wording"],
      ["second wording", "first wording"],
    ]) {
      const p = exportOf(order.map((t) => ({ tweet_id: "1", full_text: t })));
      expect(p.bookmarks.map((b) => b.text).sort()).toEqual(["first wording", "second wording"]);
      expect(p.warnings.find((w) => w.code === "duplicate-distinct-versions")?.count).toBe(1);
      const c = setup();
      const preview = previewXArchive(c.db, p);
      expect(preview.counts).toMatchObject({ new: 1, newVersions: 1 });
      const r = run(c, p);
      expect(r).toMatchObject({ newSources: 1, newVersions: 2 });
      expect(texts(c).sort()).toEqual(["first wording", "second wording"]);
    }
  });

  it("does not store a truncation as a new version over a stored complete text", () => {
    const c = setup();
    run(c, exportOf([{ tweet_id: "1", full_text: "abcd" }]));
    const p = exportOf([{ tweet_id: "1", full_text: "abc..." }], { tag: "short" });
    expect(previewXArchive(c.db, p).counts).toMatchObject({ weakerSkipped: 1, newVersions: 0 });
    const r = run(c, p, T0 + 1);
    expect(r).toMatchObject({ weakerSkipped: 1, newVersions: 0 });
    expect(texts(c)).toEqual(["abcd"]);
  });
});

describe("R2: unavailable bookmark without text keeps identity, membership and evidence", () => {
  it("records an explicit unavailable snapshot, not fabricated text", () => {
    const c = setup();
    const p = exportOf([{ tweet_id: "999", status: "unavailable" }]);
    const preview = previewXArchive(c.db, p);
    expect(preview.counts).toMatchObject({ unavailableNoText: 1, noContentSkipped: 0 });
    const r = run(c, p);
    expect(r).toMatchObject({
      status: "imported",
      newSources: 1,
      newVersions: 0,
      unavailableNoText: 1,
      noContentSkipped: 0,
    });
    expect(n(c, "SELECT COUNT(*) n FROM source WHERE platform_id = '999'")).toBe(1);
    expect(c.db.prepare("SELECT account_id, collection_id FROM membership").all()).toEqual([
      { account_id: ACCOUNT, collection_id: "x:bookmarks" },
    ]);
    expect(c.db.prepare("SELECT text, completeness FROM source_version").all()).toEqual([
      { text: "", completeness: "none" },
    ]);
    const [o, ...rest] = observations(c);
    expect(rest).toEqual([]);
    expect(o).toMatchObject({ account: ACCOUNT, availability: "unavailable", method: "import" });
    expect(evidenceOf(o!)).toEqual({ kind: "unavailable-no-text", textCaptured: false });

    const after = canonical(c);
    expect(run(c, p, T0 + 120_000).status).toBe("already-imported");
    expect(canonical(c)).toEqual(after);
  });

  it("is idempotent across a resumed pass and adds per-account evidence without new snapshots", () => {
    const c = setup();
    const p = exportOf([{ tweet_id: "999", status: "unavailable" }]);
    expect(() =>
      run(c, p, T0, {
        commitOptions: {
          onFaultPoint: (point) => {
            if (point === "before-commit") throw new Error("crash");
          },
        },
      }),
    ).toThrow("crash");
    expect(n(c, "SELECT COUNT(*) n FROM source")).toBe(0);
    run(c, p, T0 + 120_000);
    run(c, exportOf([{ tweet_id: "999", status: "unavailable" }], { user_id: OTHER }), T0 + 1);
    expect(n(c, "SELECT COUNT(*) n FROM source")).toBe(1);
    expect(n(c, "SELECT COUNT(*) n FROM source_version")).toBe(1);
    expect(observations(c).map((o) => [o.account, o.availability])).toEqual([
      [ACCOUNT, "unavailable"],
      [OTHER_ACCOUNT, "unavailable"],
    ]);
    expect(n(c, "SELECT COUNT(*) n FROM membership")).toBe(2);
  });

  it("adds recovered text later as a real version and keeps the unavailable record", () => {
    const c = setup();
    run(c, exportOf([{ tweet_id: "999", status: "unavailable" }]));
    const r = run(c, exportOf([{ tweet_id: "999", full_text: "recovered text" }]), T0 + 1);
    expect(r).toMatchObject({ newSources: 0, newVersions: 1 });
    expect(texts(c)).toEqual(["", "recovered text"]);
  });

  it("keeps the prior behavior for an available record with no text and no stored copy", () => {
    const c = setup();
    const r = run(c, exportOf([{ tweet_id: "3", status: "available", full_text: "" }]));
    expect(r).toMatchObject({ noContentSkipped: 1, unavailableNoText: 0 });
    expect(n(c, "SELECT COUNT(*) n FROM source")).toBe(0);
  });
});

describe("R3: incoming availability is recorded independently of text quality", () => {
  it("records another account's unavailable import against the retained fuller version", () => {
    const c = setup();
    const full = "previously captured complete text";
    run(c, exportOf([{ tweet_id: "999", full_text: full }], { user_id: OTHER }));
    const r = run(c, exportOf([{ tweet_id: "999", status: "unavailable" }]), T0 + 1);
    expect(r).toMatchObject({ weakerSkipped: 1, newVersions: 0, unavailableNoText: 0 });
    expect(texts(c)).toEqual([full]);
    expect(c.db.prepare("SELECT account_id FROM membership ORDER BY account_id").all()).toEqual([
      { account_id: ACCOUNT },
      { account_id: OTHER_ACCOUNT },
    ]);
    const obs = observations(c);
    expect(obs.map((o) => [o.account, o.availability, o.text])).toEqual([
      [OTHER_ACCOUNT, "available", full],
      [ACCOUNT, "unavailable", full],
    ]);
    expect(evidenceOf(obs[0]!)).toBeNull();
    expect(evidenceOf(obs[1]!)).toEqual({
      kind: "retained-fuller",
      incoming: "empty",
      textCaptured: false,
    });
  });

  it("records a weaker available import as evidence without claiming the fuller text was captured", () => {
    const c = setup();
    run(c, exportOf([{ tweet_id: "5", full_text: "abcd" }]));
    run(c, exportOf([{ tweet_id: "5", full_text: "abc…" }], { user_id: OTHER }), T0 + 1);
    const obs = observations(c);
    expect(obs.map((o) => [o.account, o.availability, o.text])).toEqual([
      [ACCOUNT, "available", "abcd"],
      [OTHER_ACCOUNT, "available", "abcd"],
    ]);
    expect(evidenceOf(obs[1]!)).toEqual({
      kind: "retained-fuller",
      incoming: "truncated",
      textCaptured: false,
    });
  });

  it("pinned upstream base/update shape: post becomes unavailable, fuller text retained", () => {
    const c = setup();
    const base = exportOf(
      [
        {
          tweet_id: "100",
          status: "available",
          created_at: "2026-07-30T12:00:00Z",
          full_text: "A synthetic saved post about gardening that later becomes unavailable.",
          author: { name: "Archive Demo", screen_name: "archive_demo" },
          folders: ["Reading"],
          folder_ids: ["f1"],
        },
        {
          tweet_id: "101",
          status: "available",
          created_at: "2026-07-31T12:00:00Z",
          full_text: "A synthetic older bookmark missing from the next snapshot.",
          author: { name: "Archive Demo", screen_name: "archive_demo" },
        },
      ],
      {
        exported_at: "2026-08-01T00:00:00.000Z",
        collection: { mode: "full", bookmarks: "complete" },
      },
    );
    const update = exportOf(
      [
        {
          tweet_id: "100",
          status: "unavailable",
          unavailable_reason: "No longer available",
          folders: ["Read later"],
          folder_ids: ["f1"],
        },
        {
          tweet_id: "102",
          status: "available",
          created_at: "2026-08-31T12:00:00Z",
          full_text: "A synthetic new bookmark about astronomy.",
          author: { name: "Archive Demo", screen_name: "archive_demo" },
        },
      ],
      {
        exported_at: "2026-09-01T00:00:00.000Z",
        collection: { mode: "full", bookmarks: "complete" },
      },
    );
    run(c, base);
    expect(run(c, base, T0 + 1).status).toBe("already-imported");
    let crashed = false;
    expect(() =>
      run(c, update, T0 + 2, {
        commitOptions: {
          onFaultPoint: (point) => {
            if (point === "before-commit" && !crashed) {
              crashed = true;
              throw new Error("crash");
            }
          },
        },
      }),
    ).toThrow("crash");
    const r = run(c, update, T0 + 120_000, { owner: "B" });
    expect(r).toMatchObject({ status: "imported", weakerSkipped: 1, newSources: 1 });
    const after = canonical(c);
    expect(run(c, update, T0 + 240_000).status).toBe("already-imported");
    expect(canonical(c)).toEqual(after);

    const post100 = c.db
      .prepare(
        `SELECT o.availability, v.text, o.evidence FROM observation o
         JOIN source s ON s.id = o.source_id JOIN source_version v ON v.id = o.version_id
         WHERE s.platform_id = '100' ORDER BY o.id`,
      )
      .all() as { availability: string; text: string; evidence: string | null }[];
    expect(post100.map((o) => o.availability)).toEqual(["available", "unavailable"]);
    expect(new Set(post100.map((o) => o.text)).size).toBe(1);
    expect(JSON.parse(post100[1]!.evidence!)).toMatchObject({ textCaptured: false });
    expect(n(c, "SELECT COUNT(*) n FROM source_version")).toBe(3);
    expect(n(c, "SELECT COUNT(*) n FROM observation")).toBe(4);
    expect(n(c, "SELECT COUNT(*) n FROM membership")).toBe(3);
  });

  it("repository fixtures: the update's unavailable post records unavailability for the account", () => {
    const c = setup();
    run(c, fixture("v1-legacy.json"));
    const update = fixture("v2-update.json");
    expect(previewXArchive(c.db, update).counts).toMatchObject({ weakerSkipped: 1 });
    run(c, update, T0 + 1);
    const rows = c.db
      .prepare(
        `SELECT o.availability FROM observation o JOIN source s ON s.id = o.source_id
         WHERE s.platform_id = ? ORDER BY o.id`,
      )
      .all(ID100);
    expect(rows).toEqual([{ availability: "available" }, { availability: "unavailable" }]);
    expect(n(c, "SELECT COUNT(*) n FROM source_version")).toBe(3);
  });
});
