import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  AccountMismatchError,
  CaptureStore,
  CursorMismatchError,
  InvalidPageError,
  JobStore,
  LeaseError,
  ReplayConflictError,
  migrate,
  type CapturePage,
  type Lease,
} from "./index.ts";
import {
  ACCOUNT,
  COLLECTION,
  PAGE_COUNT,
  SHARED_TEXT,
  allPages,
  expectedDistinctPosts,
  expectedDistinctVersions,
  pageAt,
} from "./testing/synthetic-feed.ts";

const T0 = 1_800_000_000_000;
const TTL = 60_000;

const setup = () => {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const jobs = new JobStore(db);
  jobs.create({ id: "j1", kind: "capture", accountId: ACCOUNT, collectionId: COLLECTION });
  const lease = jobs.acquire("j1", "A", T0, TTL);
  if (!lease) throw new Error("setup could not acquire the lease");
  return { db, jobs, lease, capture: new CaptureStore(db, jobs) };
};

const count = (db: Database.Database, table: string): number =>
  (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;

/** Every row of the canonical tables that a replay must leave untouched. */
const canonical = (db: Database.Database) =>
  Object.fromEntries(
    ["source", "source_version", "observation", "membership"].map((t) => [
      t,
      db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all(),
    ]),
  );

const commitAll = (capture: CaptureStore, lease: Lease, pages: CapturePage[], now = T0) =>
  pages.map((p) => capture.commitPage("j1", lease, now, p));

describe("capture commit", () => {
  it("commits a page and its cursor together and completes at a recognized end", () => {
    const { db, jobs, capture, lease } = setup();
    const results = commitAll(capture, lease, allPages("p1"));
    expect(results.every((r) => r.status === "committed")).toBe(true);
    expect(results.at(-1)).toMatchObject({ ended: true, cursor: null });
    expect(count(db, "source")).toBe(expectedDistinctPosts());
    expect(count(db, "source_version")).toBe(expectedDistinctVersions());
    expect(count(db, "membership")).toBe(expectedDistinctPosts());
    expect(count(db, "observation")).toBe(expectedDistinctVersions());
    const job = jobs.get("j1");
    expect(job.state).toBe("complete");
    expect(job.cursor).toBeNull();
    expect(job.leaseOwner).toBeNull();
    expect(job.stopReason).toMatch(/recognized end/);
  });

  it("advances the job cursor to the last committed continuation", () => {
    const { jobs, capture, lease } = setup();
    commitAll(capture, lease, allPages("p1").slice(0, 3));
    expect(jobs.get("j1").cursor).toBe(pageAt("p1", 2).cursorOut);
    expect(jobs.get("j1").state).toBe("running");
  });

  it("keeps identical text under different IDs distinct and adds a version for changed text", () => {
    const { db, capture, lease } = setup();
    commitAll(capture, lease, allPages("p1"));
    const shared = db
      .prepare("SELECT COUNT(DISTINCT source_id) n FROM source_version WHERE text = ?")
      .get(SHARED_TEXT) as { n: number };
    expect(shared.n).toBeGreaterThan(1);
    const multi = db
      .prepare(
        "SELECT COUNT(*) n FROM (SELECT source_id FROM source_version GROUP BY source_id HAVING COUNT(*) > 1)",
      )
      .get() as { n: number };
    expect(multi.n).toBeGreaterThan(0);
    const id = allPages("p1")[0]!.records[0]!.platformId;
    expect(db.prepare("SELECT platform_id FROM source WHERE platform_id = ?").get(id)).toEqual({
      platform_id: id,
    });
  });

  it("replaying a committed page in the same pass is a no-op", () => {
    const { db, capture, lease } = setup();
    const pages = allPages("p1").slice(0, 3);
    const first = commitAll(capture, lease, pages);
    const before = { ...canonical(db), pages: count(db, "capture_page") };
    const again = commitAll(capture, lease, pages);
    expect(again.map((r) => r.status)).toEqual(["replayed", "replayed", "replayed"]);
    expect(again.map((r) => r.seq)).toEqual(first.map((r) => r.seq));
    expect({ ...canonical(db), pages: count(db, "capture_page") }).toEqual(before);
  });

  it("replays a fresh pass with new cursors as a no-op on canonical records, then continues (ADR 0005)", () => {
    const { db, jobs, capture, lease } = setup();
    commitAll(capture, lease, allPages("p1").slice(0, 4));
    const before = canonical(db);

    const catchUp = commitAll(capture, lease, allPages("p2").slice(0, 4));
    expect(catchUp.every((r) => r.status === "committed" && r.newRecords === 0)).toBe(true);
    expect(canonical(db)).toEqual(before);
    expect(jobs.get("j1").cursor).toBe(pageAt("p2", 3).cursorOut);

    const next = capture.commitPage("j1", lease, T0, pageAt("p2", 4));
    expect(next.newRecords).toBeGreaterThan(0);
    commitAll(capture, lease, allPages("p2").slice(5));
    expect(count(db, "source")).toBe(expectedDistinctPosts());
    expect(count(db, "observation")).toBe(expectedDistinctVersions());
    expect(jobs.get("j1").state).toBe("complete");
  });

  it("acknowledges a re-sent final page after completion and accepts nothing new", () => {
    const { db, capture, lease } = setup();
    commitAll(capture, lease, allPages("p1"));
    const before = { ...canonical(db), pages: count(db, "capture_page") };
    const last = pageAt("p1", PAGE_COUNT - 1);
    expect(capture.commitPage("j1", lease, T0 + 1, last)).toMatchObject({
      status: "replayed",
      ended: true,
      seq: PAGE_COUNT - 1,
    });
    expect(() => capture.commitPage("j1", lease, T0 + 1, pageAt("p2", 0))).toThrow(LeaseError);
    expect(() =>
      capture.commitPage("j1", lease, T0 + 1, { ...last, accountId: "x:account:2" }),
    ).toThrow(AccountMismatchError);
    expect({ ...canonical(db), pages: count(db, "capture_page") }).toEqual(before);
  });

  it("rejects a replay with a different continuation or different content", () => {
    const { capture, lease } = setup();
    const page = pageAt("p1", 0);
    capture.commitPage("j1", lease, T0, page);
    expect(() => capture.commitPage("j1", lease, T0, { ...page, cursorOut: "p1/other" })).toThrow(
      CursorMismatchError,
    );
    expect(() =>
      capture.commitPage("j1", lease, T0, { ...page, records: page.records.slice(1) }),
    ).toThrow(ReplayConflictError);
  });

  it("rejects skipped pages and passes that do not start at the top", () => {
    const { db, jobs, capture, lease } = setup();
    capture.commitPage("j1", lease, T0, pageAt("p1", 0));
    expect(() => capture.commitPage("j1", lease, T0, pageAt("p1", 2))).toThrow(CursorMismatchError);
    expect(() => capture.commitPage("j1", lease, T0, pageAt("p2", 1))).toThrow(CursorMismatchError);
    expect(count(db, "capture_page")).toBe(1);
    expect(count(db, "capture_pass")).toBe(1);
    expect(jobs.get("j1").cursor).toBe(pageAt("p1", 0).cursorOut);
  });

  it("refuses a page from another account or collection before any write and pauses the job (CAP-02)", () => {
    for (const change of [{ accountId: "x:account:2" }, { collectionId: "x:likes" }]) {
      const { db, jobs, capture, lease } = setup();
      expect(() => capture.commitPage("j1", lease, T0, { ...pageAt("p1", 0), ...change })).toThrow(
        AccountMismatchError,
      );
      expect(count(db, "source")).toBe(0);
      expect(count(db, "capture_page")).toBe(0);
      const job = jobs.get("j1");
      expect(job.state).toBe("paused");
      expect(job.stopReason).toMatch(/account/);
      expect(job.leaseOwner).toBeNull();
    }
  });

  it("fences owners without a live lease", () => {
    const { db, jobs, capture, lease } = setup();
    const other: Lease = { owner: "B", generation: lease.generation };
    expect(() => capture.commitPage("j1", other, T0, pageAt("p1", 0))).toThrow(LeaseError);
    expect(() => capture.commitPage("j1", null, T0, pageAt("p1", 0))).toThrow(LeaseError);
    expect(() => capture.commitPage("j1", lease, T0 + TTL, pageAt("p1", 0))).toThrow(LeaseError);
    const b = jobs.acquire("j1", "B", T0 + TTL, TTL);
    expect(b).toEqual({ owner: "B", generation: lease.generation + 1 });
    expect(() => capture.commitPage("j1", lease, T0 + TTL + 1, pageAt("p1", 0))).toThrow(
      LeaseError,
    );
    expect(count(db, "source")).toBe(0);
  });

  it("rejects a stale generation of the same owner after it reacquires (retained token)", () => {
    const { db, jobs, capture, lease: stale } = setup();
    // The first attempt stalls past expiry; the same owner name reacquires a new generation.
    const fresh = jobs.acquire("j1", "A", T0 + TTL, TTL);
    expect(fresh).toEqual({ owner: "A", generation: stale.generation + 1 });
    expect(() => capture.commitPage("j1", stale, T0 + TTL + 1, pageAt("p1", 0))).toThrow(
      LeaseError,
    );
    expect(count(db, "capture_page")).toBe(0);
    expect(jobs.get("j1").cursor).toBeNull();
    // Only the retained token of the live acquisition commits.
    expect(capture.commitPage("j1", fresh!, T0 + TTL + 1, pageAt("p1", 0)).status).toBe(
      "committed",
    );
  });

  it.each([Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid clock %s before reading or writing anything",
    (bad) => {
      const { db, jobs, capture, lease } = setup();
      expect(() => capture.commitPage("j1", lease, bad, pageAt("p1", 0))).toThrow(RangeError);
      expect(() => capture.commitPage("missing", lease, bad, pageAt("p1", 0))).toThrow(RangeError);
      expect(count(db, "capture_page")).toBe(0);
      expect(jobs.get("j1")).toMatchObject({ state: "running", leaseOwner: "A", cursor: null });
    },
  );

  it("acknowledges a re-sent final page without any lease once the job is complete", () => {
    const { db, capture, lease } = setup();
    commitAll(capture, lease, allPages("p1"));
    const before = { ...canonical(db), pages: count(db, "capture_page") };
    const last = pageAt("p1", PAGE_COUNT - 1);
    expect(capture.commitPage("j1", null, T0 + 1, last)).toMatchObject({ status: "replayed" });
    expect(() => capture.commitPage("j1", null, T0 + 1, pageAt("p3", 0))).toThrow(LeaseError);
    expect({ ...canonical(db), pages: count(db, "capture_page") }).toEqual(before);
  });

  it("reuses the persisted ID of an existing canonical source (review: source ID drift)", () => {
    const { db, capture, lease } = setup();
    const page = pageAt("p1", 0);
    const first = page.records[0]!;
    // A source recorded earlier (importer or older build) under a different ID scheme.
    db.prepare("INSERT INTO source (id, source_type, platform_id) VALUES ('legacy-1', ?, ?)").run(
      first.sourceType,
      first.platformId,
    );
    expect(capture.commitPage("j1", lease, T0, page).status).toBe("committed");
    const rows = db
      .prepare("SELECT id FROM source WHERE source_type = ? AND platform_id = ?")
      .all(first.sourceType, first.platformId);
    expect(rows).toEqual([{ id: "legacy-1" }]);
    expect(
      db
        .prepare(
          "SELECT COUNT(*) n FROM observation WHERE source_id = 'legacy-1' AND job_id = 'j1'",
        )
        .get(),
    ).toEqual({ n: 1 });
    expect(
      db.prepare("SELECT COUNT(*) n FROM membership WHERE source_id = 'legacy-1'").get(),
    ).toEqual({ n: 1 });
  });

  it("never attaches a record to a different identity that occupies its derived ID", () => {
    const { db, capture, lease } = setup();
    const base = pageAt("p1", 0);
    // "a:b" + "c" and "a" + "b:c" would both derive "a:b:c"; an unrelated row also holds it.
    db.prepare(
      "INSERT INTO source (id, source_type, platform_id) VALUES ('a:b:c', 'other', NULL)",
    ).run();
    const page: CapturePage = {
      ...base,
      records: [
        { sourceType: "a:b", platformId: "c", text: "one" },
        { sourceType: "a", platformId: "b:c", text: "two" },
      ],
    };
    capture.commitPage("j1", lease, T0, page);
    const rows = db
      .prepare(
        "SELECT s.id, s.source_type, s.platform_id, v.text FROM source s JOIN source_version v ON v.source_id = s.id ORDER BY v.text",
      )
      .all() as { id: string; source_type: string; platform_id: string; text: string }[];
    expect(rows.map((r) => [r.source_type, r.platform_id, r.text])).toEqual([
      ["a:b", "c", "one"],
      ["a", "b:c", "two"],
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rows.some((r) => r.id === "a:b:c")).toBe(false);
    expect(db.prepare("SELECT source_type FROM source WHERE id = 'a:b:c'").get()).toEqual({
      source_type: "other",
    });
  });

  it("rejects malformed pages, including numeric platform IDs", () => {
    const { db, capture, lease } = setup();
    const page = pageAt("p1", 0);
    const bad: CapturePage[] = [
      { ...page, passId: "" },
      { ...page, cursorOut: "" },
      { ...page, adapter: { id: "synthetic", version: "" } },
      {
        ...page,
        records: [
          {
            ...page.records[0]!,
            platformId: Number(page.records[0]!.platformId) as unknown as string,
          },
        ],
      },
    ];
    for (const p of bad) {
      expect(() => capture.commitPage("j1", lease, T0, p)).toThrow(InvalidPageError);
    }
    expect(count(db, "source")).toBe(0);
  });

  it("rolls back the whole page when the transaction is interrupted", () => {
    for (const point of ["mid-page", "before-commit"] as const) {
      const { db, jobs, capture, lease } = setup();
      capture.commitPage("j1", lease, T0, pageAt("p1", 0));
      const before = { ...canonical(db), pages: count(db, "capture_page") };
      expect(() =>
        capture.commitPage("j1", lease, T0, pageAt("p1", 1), {
          onFaultPoint: (p) => {
            if (p === point) throw new Error("injected");
          },
        }),
      ).toThrow("injected");
      expect({ ...canonical(db), pages: count(db, "capture_page") }).toEqual(before);
      expect(jobs.get("j1").cursor).toBe(pageAt("p1", 0).cursorOut);
    }
  });

  it("reports a pending cancel request to the owner", () => {
    const { jobs, capture, lease } = setup();
    jobs.cancel("j1", T0);
    expect(capture.commitPage("j1", lease, T0, pageAt("p1", 0)).cancelRequested).toBe(true);
  });

  it("summarizes committed pages, distinct IDs, adapters, and termination evidence (CAP-06)", () => {
    const { capture, lease } = setup();
    commitAll(capture, lease, allPages("p1").slice(0, 2));
    expect(capture.summary("j1")).toMatchObject({ pages: 2, passes: 1, end: null });
    commitAll(capture, lease, allPages("p2"));
    expect(capture.summary("j1")).toEqual({
      pages: 2 + PAGE_COUNT,
      passes: 2,
      distinctSources: expectedDistinctPosts(),
      adapters: ["synthetic@1.0.0"],
      end: {
        passId: "p2",
        seq: PAGE_COUNT - 1,
        cursorIn: pageAt("p2", PAGE_COUNT - 1).cursorIn,
        adapter: "synthetic@1.0.0",
        committedAt: new Date(T0).toISOString(),
      },
    });
  });
});
