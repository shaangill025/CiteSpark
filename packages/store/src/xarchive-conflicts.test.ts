import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  CaptureStore,
  JobStore,
  ReplayConflictError,
  commitXArchive,
  migrate,
  parseXArchive,
  previewXArchive,
  type CapturePage,
  type CaptureRecord,
  type CommitImportOptions,
  type ParsedExport,
} from "./index.ts";

/**
 * Review regression R3 (MIG-01, Q37, T09): availability reported for one post in one import is
 * evidence independent of in-file text deduplication and of the one-observation-per-job-and-version
 * rule. Conflicting reports are kept on that observation without inventing an order. Synthetic data.
 */

const T0 = 1_800_000_000_000;
const OWNER = "42";
const OTHER = "43";

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
const exportOf = (bookmarks: unknown[], meta: Record<string, unknown> = {}): ParsedExport =>
  parseXArchive(
    JSON.stringify({
      export_metadata: { tool: "xarchive", schema_version: 2, user_id: OWNER, ...meta },
      bookmarks,
    }),
  );
const all = (c: Ctx, t: string): Record<string, unknown>[] =>
  c.db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all() as Record<string, unknown>[];
/** Observations of one job, as order-free content: version text, availability, parsed evidence. */
const obsOf = (c: Ctx, jobId: string) =>
  (
    c.db
      .prepare(
        `SELECT v.text, v.completeness, o.availability, o.evidence, o.method
         FROM observation o JOIN source_version v ON v.id = o.version_id
         WHERE o.job_id = ? ORDER BY v.text, o.availability`,
      )
      .all(jobId) as {
      text: string;
      completeness: string;
      availability: string;
      evidence: string | null;
      method: string;
    }[]
  ).map((o) => ({ ...o, evidence: o.evidence === null ? null : JSON.parse(o.evidence) }));
const receiptCounts = (r: ReturnType<typeof run>) => ({
  newRecords: r.newRecords,
  newSources: r.newSources,
  newVersions: r.newVersions,
  weakerSkipped: r.weakerSkipped,
  unavailableNoText: r.unavailableNoText,
  noContentSkipped: r.noContentSkipped,
});
const conflict = (reports: { availability: string; text: string }[]) => ({
  kind: "conflicting-availability",
  chronology: "unknown",
  textCaptured: reports.some((r) => r.text === "captured"),
  reports,
});

/** Runs one in-file pair in both orders and returns the order-independent outcome of each. */
const bothOrders = (a: unknown, b: unknown) =>
  [
    [a, b],
    [b, a],
  ].map((rows) => {
    const c = setup();
    const p = exportOf(rows);
    const preview = previewXArchive(c.db, p);
    const r = run(c, p);
    return {
      versions: (all(c, "source_version") as { text: string }[]).map((v) => v.text).sort(),
      sources: all(c, "source").length,
      memberships: all(c, "membership").length,
      observations: obsOf(c, r.jobId),
      counts: receiptCounts(r),
      preview: preview.counts,
      replay: run(c, p, T0 + 1).status,
    };
  });

describe("R3: in-file mixed-status duplicates keep both availability reports", () => {
  const full = { tweet_id: "777", full_text: "abcd", status: "available" };

  it("textless unavailable duplicate of an available complete text, both orders", () => {
    const [x, y] = bothOrders(full, { tweet_id: "777", status: "unavailable" });
    expect(x).toEqual(y);
    expect(x!.versions).toEqual(["abcd"]);
    expect(x!.sources).toBe(1);
    expect(x!.memberships).toBe(1);
    expect(x!.observations).toEqual([
      {
        text: "abcd",
        completeness: "unknown",
        availability: "conflicting",
        method: "import",
        evidence: conflict([
          { availability: "available", text: "captured" },
          { availability: "unavailable", text: "empty" },
        ]),
      },
    ]);
    expect(x!.counts).toMatchObject({ newRecords: 1, newVersions: 1, weakerSkipped: 0 });
    expect(x!.replay).toBe("already-imported");
  });

  it("truncated unavailable duplicate (… and ...) of an available complete text, both orders", () => {
    for (const short of ["abc…", "abc..."]) {
      const [x, y] = bothOrders(full, { tweet_id: "777", full_text: short, status: "unavailable" });
      expect(x).toEqual(y);
      expect(x!.versions).toEqual(["abcd"]);
      expect(x!.observations.map((o) => [o.availability, o.evidence])).toEqual([
        [
          "conflicting",
          conflict([
            { availability: "available", text: "captured" },
            { availability: "unavailable", text: "truncated" },
          ]),
        ],
      ]);
    }
  });

  it("available truncation of an unavailable complete text keeps which report carried the text", () => {
    const [x, y] = bothOrders(
      { tweet_id: "777", full_text: "abcd", status: "unavailable" },
      { tweet_id: "777", full_text: "abc…", status: "available" },
    );
    expect(x).toEqual(y);
    expect(x!.observations[0]!.evidence).toEqual(
      conflict([
        { availability: "available", text: "truncated" },
        { availability: "unavailable", text: "captured" },
      ]),
    );
  });

  it("identical text with different statuses is one version with both reports, both orders", () => {
    const [x, y] = bothOrders(full, { ...full, status: "unavailable" });
    expect(x).toEqual(y);
    expect(x!.versions).toEqual(["abcd"]);
    expect(x!.observations.map((o) => [o.availability, o.evidence])).toEqual([
      [
        "conflicting",
        conflict([
          { availability: "available", text: "captured" },
          { availability: "unavailable", text: "captured" },
        ]),
      ],
    ]);
  });

  it("textless records with both statuses record the empty snapshot as conflicting", () => {
    const [x, y] = bothOrders(
      { tweet_id: "777", status: "available" },
      { tweet_id: "777", status: "unavailable" },
    );
    expect(x).toEqual(y);
    expect(x!.observations).toEqual([
      {
        text: "",
        completeness: "none",
        availability: "conflicting",
        method: "import",
        evidence: conflict([
          { availability: "available", text: "none" },
          { availability: "unavailable", text: "none" },
        ]),
      },
    ]);
    expect(x!.counts).toMatchObject({ unavailableNoText: 1, noContentSkipped: 0, newVersions: 0 });
    expect(x!.preview).toMatchObject({ unavailableNoText: 1, noContentSkipped: 0 });
  });

  it("same-status weaker duplicates keep the single-report shape (no spurious conflict)", () => {
    const [x, y] = bothOrders(full, { tweet_id: "777", status: "available" });
    expect(x).toEqual(y);
    expect(x!.observations.map((o) => [o.availability, o.evidence])).toEqual([["available", null]]);
    const [u, v] = bothOrders(
      { tweet_id: "777", full_text: "abc…", status: "unavailable" },
      { tweet_id: "777", status: "unavailable" },
    );
    expect(u).toEqual(v);
    expect(u!.observations.map((o) => [o.text, o.availability, o.evidence])).toEqual([
      ["abc…", "unavailable", null],
    ]);
  });

  it("distinct texts with different statuses stay separate versions with their own status", () => {
    const [x, y] = bothOrders(full, { tweet_id: "777", full_text: "wxyz", status: "unavailable" });
    expect(x).toEqual(y);
    expect(x!.observations.map((o) => [o.text, o.availability, o.evidence])).toEqual([
      ["abcd", "available", null],
      ["wxyz", "unavailable", null],
    ]);
  });

  it("warns about conflicting availability and parses to the same records in both orders", () => {
    const a = exportOf([full, { tweet_id: "777", status: "unavailable" }]);
    const b = exportOf([{ tweet_id: "777", status: "unavailable" }, full]);
    expect(a.bookmarks).toEqual(b.bookmarks);
    expect(a.warnings.find((w) => w.code === "conflicting-availability")?.count).toBe(1);
    // The files differ byte-wise, so only the job ID (a content hash) may differ.
    const { jobId: ja, ...pa } = previewXArchive(setup().db, a);
    const { jobId: jb, ...pb } = previewXArchive(setup().db, b);
    expect(ja).not.toBe(jb);
    expect(pa).toEqual(pb);
    expect(pa.records).toEqual([
      {
        sourceType: "x_post",
        platformId: "777",
        text: "abcd",
        authorId: null,
        authorHandle: null,
        canonicalUrl: null,
        publishedAt: null,
        availability: "available",
        retainFuller: true,
        alsoReported: [{ availability: "unavailable", text: "empty" }],
      },
    ]);
  });

  it("duplicates on opposite sides of a page boundary give the same state in both orders", () => {
    const filler = Array.from({ length: 140 }, (_, i) => ({
      tweet_id: String(5000 + i),
      full_text: `filler ${i}`,
    }));
    const weak = { tweet_id: "777", status: "unavailable" };
    const outcomes = [
      [full, ...filler, weak],
      [weak, ...filler, full],
    ].map((rows) => {
      const c = setup();
      const r = run(c, exportOf(rows));
      expect(r.pages).toBe(2);
      return obsOf(c, r.jobId).filter((o) => o.text === "abcd" || o.text === "");
    });
    expect(outcomes[0]).toEqual(outcomes[1]);
    expect(outcomes[0]!.map((o) => o.availability)).toEqual(["conflicting"]);
  });
});

describe("R3: commit merges reports into the one observation per job and version", () => {
  const record = (text: string, availability: "available" | "unavailable"): CaptureRecord => ({
    sourceType: "x_post",
    platformId: "780",
    text,
    availability,
    retainFuller: true,
  });
  /** Stores the fuller text from another account, then commits `pages` directly (parser bypass). */
  const direct = (
    pages: CaptureRecord[][],
    options: { crashOnce?: number; secondPass?: boolean } = {},
  ) => {
    const c = setup();
    run(c, exportOf([{ tweet_id: "780", full_text: "abcd" }], { user_id: OTHER }));
    c.jobs.create({
      id: "imp",
      kind: "import",
      accountId: "x:account:42",
      collectionId: "x:bookmarks",
    });
    const lease = c.jobs.acquire("imp", "A", T0, 60_000)!;
    const page = (i: number, passId = "p"): CapturePage => ({
      passId,
      accountId: "x:account:42",
      collectionId: "x:bookmarks",
      cursorIn: i === 0 ? null : `c${i}`,
      cursorOut: i === pages.length - 1 ? null : `c${i + 1}`,
      adapter: { id: "xarchive-import", version: "t" },
      method: "import",
      records: pages[i]!,
    });
    let crashed = false;
    const totals = { weakerSkipped: 0, newRecords: 0, newVersions: 0 };
    const pageCount = options.secondPass ? pages.length - 1 : pages.length;
    for (let i = 0; i < pageCount; i++) {
      if (options.crashOnce === i && !crashed) {
        crashed = true;
        expect(() =>
          c.capture.commitPage("imp", lease, T0, page(i), {
            onFaultPoint: (pt) => {
              if (pt === "before-commit") throw new Error("crash");
            },
          }),
        ).toThrow("crash");
      }
      const r = c.capture.commitPage("imp", lease, T0, page(i));
      totals.weakerSkipped += r.weakerSkipped;
      totals.newRecords += r.newRecords;
      totals.newVersions += r.newVersions;
      if (options.crashOnce === i) {
        expect(c.capture.commitPage("imp", lease, T0, page(i)).status).toBe("replayed");
      }
    }
    if (options.secondPass) {
      // A fresh pass re-reads every committed page from the top before finishing (ADR 0005).
      for (let i = 0; i < pages.length; i++) c.capture.commitPage("imp", lease, T0, page(i, "q"));
    }
    return { c, obs: obsOf(c, "imp"), totals, versions: all(c, "source_version").length };
  };

  const expected = [
    {
      text: "abcd",
      completeness: "unknown",
      availability: "conflicting",
      method: "import",
      evidence: conflict([
        { availability: "available", text: "empty" },
        { availability: "unavailable", text: "truncated" },
      ]),
    },
  ];

  it("two weaker records with different statuses on one page, both orders", () => {
    const a = direct([[record("abc…", "unavailable"), record("", "available")]]);
    const b = direct([[record("", "available"), record("abc…", "unavailable")]]);
    for (const x of [a, b]) {
      expect(x.obs).toEqual(expected);
      expect(x.versions).toBe(1);
      expect(x.totals).toEqual({ weakerSkipped: 2, newRecords: 0, newVersions: 0 });
    }
  });

  it("two weaker records on different pages, both orders", () => {
    const a = direct([[record("abc…", "unavailable")], [record("", "available")]]);
    const b = direct([[record("", "available")], [record("abc…", "unavailable")]]);
    expect(a.obs).toEqual(expected);
    expect(b.obs).toEqual(expected);
  });

  it("a crash after a merge rolls back and the retry does not duplicate evidence", () => {
    const clean = direct([[record("abc…", "unavailable")], [record("", "available")]]);
    const crashed = direct([[record("abc…", "unavailable")], [record("", "available")]], {
      crashOnce: 1,
    });
    expect(crashed.obs).toEqual(clean.obs);
    expect(crashed.obs).toEqual(expected);
    const again = direct([[record("abc…", "unavailable")], [record("", "available")]], {
      secondPass: true,
    });
    expect(again.obs).toEqual(expected);
  });

  it("repeated reports of one status are idempotent and keep the strongest text kind", () => {
    const x = direct([
      [record("", "unavailable"), record("abc…", "unavailable")],
      [record("", "unavailable")],
    ]);
    expect(x.obs.map((o) => [o.availability, o.evidence])).toEqual([
      ["unavailable", { kind: "retained-fuller", incoming: "truncated", textCaptured: false }],
    ]);
  });
});

describe("R3: page fingerprints", () => {
  const base = { sourceType: "x_post", platformId: "1", text: "hello" };
  const page = (records: CaptureRecord[], method?: "import"): CapturePage => ({
    passId: "p",
    accountId: "a",
    collectionId: "b",
    cursorIn: null,
    cursorOut: "next",
    adapter: { id: "a", version: "1" },
    ...(method ? { method } : {}),
    records,
  });
  const committed = (records: CaptureRecord[]) => {
    const c = setup();
    c.jobs.create({ id: "cap", kind: "capture", accountId: "a", collectionId: "b" });
    const lease = c.jobs.acquire("cap", "A", T0, 60_000)!;
    c.capture.commitPage("cap", lease, T0, page(records));
    return { c, lease };
  };

  it("keeps the historical seven-field fingerprint for records without extra reports", () => {
    const { c } = committed([base]);
    const legacy = createHash("sha256")
      .update(JSON.stringify([["x_post", "1", "hello", null, null, null, null]]))
      .digest("hex");
    expect(all(c, "capture_page")[0]!.content_hash).toBe(legacy);
  });

  it("binds extra reports into the fingerprint, independent of their order", () => {
    const also = [
      { availability: "unavailable" as const, text: "empty" as const },
      { availability: "available" as const, text: "truncated" as const },
    ];
    const rec = { ...base, retainFuller: true, alsoReported: also };
    const { c, lease } = committed([rec]);
    expect(
      c.capture.commitPage("cap", lease, T0, page([{ ...rec, alsoReported: [...also].reverse() }]))
        .status,
    ).toBe("replayed");
    expect(() =>
      c.capture.commitPage("cap", lease, T0, page([{ ...base, retainFuller: true }])),
    ).toThrow(ReplayConflictError);
    expect(() =>
      c.capture.commitPage("cap", lease, T0, page([{ ...rec, alsoReported: [also[0]!] }])),
    ).toThrow(ReplayConflictError);
  });
});
