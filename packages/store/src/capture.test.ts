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
  jobs.acquire("j1", "A", T0, TTL);
  return { db, jobs, capture: new CaptureStore(db, jobs) };
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

const commitAll = (capture: CaptureStore, pages: CapturePage[], owner = "A", now = T0) =>
  pages.map((p) => capture.commitPage("j1", owner, now, p));

describe("capture commit", () => {
  it("commits a page and its cursor together and completes at a recognized end", () => {
    const { db, jobs, capture } = setup();
    const results = commitAll(capture, allPages("p1"));
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
    const { jobs, capture } = setup();
    commitAll(capture, allPages("p1").slice(0, 3));
    expect(jobs.get("j1").cursor).toBe(pageAt("p1", 2).cursorOut);
    expect(jobs.get("j1").state).toBe("running");
  });

  it("keeps identical text under different IDs distinct and adds a version for changed text", () => {
    const { db, capture } = setup();
    commitAll(capture, allPages("p1"));
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
    const { db, capture } = setup();
    const pages = allPages("p1").slice(0, 3);
    const first = commitAll(capture, pages);
    const before = { ...canonical(db), pages: count(db, "capture_page") };
    const again = commitAll(capture, pages);
    expect(again.map((r) => r.status)).toEqual(["replayed", "replayed", "replayed"]);
    expect(again.map((r) => r.seq)).toEqual(first.map((r) => r.seq));
    expect({ ...canonical(db), pages: count(db, "capture_page") }).toEqual(before);
  });

  it("replays a fresh pass with new cursors as a no-op on canonical records, then continues (ADR 0005)", () => {
    const { db, jobs, capture } = setup();
    commitAll(capture, allPages("p1").slice(0, 4));
    const before = canonical(db);

    const catchUp = commitAll(capture, allPages("p2").slice(0, 4));
    expect(catchUp.every((r) => r.status === "committed" && r.newRecords === 0)).toBe(true);
    expect(canonical(db)).toEqual(before);
    expect(jobs.get("j1").cursor).toBe(pageAt("p2", 3).cursorOut);

    const next = capture.commitPage("j1", "A", T0, pageAt("p2", 4));
    expect(next.newRecords).toBeGreaterThan(0);
    commitAll(capture, allPages("p2").slice(5));
    expect(count(db, "source")).toBe(expectedDistinctPosts());
    expect(count(db, "observation")).toBe(expectedDistinctVersions());
    expect(jobs.get("j1").state).toBe("complete");
  });

  it("acknowledges a re-sent final page after completion and accepts nothing new", () => {
    const { db, capture } = setup();
    commitAll(capture, allPages("p1"));
    const before = { ...canonical(db), pages: count(db, "capture_page") };
    const last = pageAt("p1", PAGE_COUNT - 1);
    expect(capture.commitPage("j1", "A", T0 + 1, last)).toMatchObject({
      status: "replayed",
      ended: true,
      seq: PAGE_COUNT - 1,
    });
    expect(() => capture.commitPage("j1", "A", T0 + 1, pageAt("p2", 0))).toThrow(LeaseError);
    expect(() =>
      capture.commitPage("j1", "A", T0 + 1, { ...last, accountId: "x:account:2" }),
    ).toThrow(AccountMismatchError);
    expect({ ...canonical(db), pages: count(db, "capture_page") }).toEqual(before);
  });

  it("rejects a replay with a different continuation or different content", () => {
    const { capture } = setup();
    const page = pageAt("p1", 0);
    capture.commitPage("j1", "A", T0, page);
    expect(() => capture.commitPage("j1", "A", T0, { ...page, cursorOut: "p1/other" })).toThrow(
      CursorMismatchError,
    );
    expect(() =>
      capture.commitPage("j1", "A", T0, { ...page, records: page.records.slice(1) }),
    ).toThrow(ReplayConflictError);
  });

  it("rejects skipped pages and passes that do not start at the top", () => {
    const { db, jobs, capture } = setup();
    capture.commitPage("j1", "A", T0, pageAt("p1", 0));
    expect(() => capture.commitPage("j1", "A", T0, pageAt("p1", 2))).toThrow(CursorMismatchError);
    expect(() => capture.commitPage("j1", "A", T0, pageAt("p2", 1))).toThrow(CursorMismatchError);
    expect(count(db, "capture_page")).toBe(1);
    expect(count(db, "capture_pass")).toBe(1);
    expect(jobs.get("j1").cursor).toBe(pageAt("p1", 0).cursorOut);
  });

  it("refuses a page from another account or collection before any write and pauses the job (CAP-02)", () => {
    for (const change of [{ accountId: "x:account:2" }, { collectionId: "x:likes" }]) {
      const { db, jobs, capture } = setup();
      expect(() => capture.commitPage("j1", "A", T0, { ...pageAt("p1", 0), ...change })).toThrow(
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
    const { db, jobs, capture } = setup();
    expect(() => capture.commitPage("j1", "B", T0, pageAt("p1", 0))).toThrow(LeaseError);
    expect(() => capture.commitPage("j1", "A", T0 + TTL, pageAt("p1", 0))).toThrow(LeaseError);
    expect(jobs.acquire("j1", "B", T0 + TTL, TTL)).toBe(true);
    expect(() => capture.commitPage("j1", "A", T0 + TTL + 1, pageAt("p1", 0))).toThrow(LeaseError);
    expect(count(db, "source")).toBe(0);
  });

  it("rejects malformed pages, including numeric platform IDs", () => {
    const { db, capture } = setup();
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
      expect(() => capture.commitPage("j1", "A", T0, p)).toThrow(InvalidPageError);
    }
    expect(count(db, "source")).toBe(0);
  });

  it("rolls back the whole page when the transaction is interrupted", () => {
    for (const point of ["mid-page", "before-commit"] as const) {
      const { db, jobs, capture } = setup();
      capture.commitPage("j1", "A", T0, pageAt("p1", 0));
      const before = { ...canonical(db), pages: count(db, "capture_page") };
      expect(() =>
        capture.commitPage("j1", "A", T0, pageAt("p1", 1), {
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
    const { jobs, capture } = setup();
    jobs.cancel("j1", T0);
    expect(capture.commitPage("j1", "A", T0, pageAt("p1", 0)).cancelRequested).toBe(true);
  });

  it("summarizes committed pages, distinct IDs, adapters, and termination evidence (CAP-06)", () => {
    const { capture } = setup();
    commitAll(capture, allPages("p1").slice(0, 2));
    expect(capture.summary("j1")).toMatchObject({ pages: 2, passes: 1, end: null });
    commitAll(capture, allPages("p2"));
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
