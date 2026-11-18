import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { CaptureStore, CursorLoopError, JobStore, migrate } from "./index.ts";
import { ACCOUNT, COLLECTION, allPages, cursorFor, pageAt } from "./testing/synthetic-feed.ts";

// T02 store part (M1-08): gaps and cursor loops never become a false `complete`.
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

describe("gaps end a pass as partial (T02, CAP-06)", () => {
  it("ends a pass that saw unavailable entries or partial threads as partial", () => {
    const { jobs, capture, lease } = setup();
    const pages = allPages("p1");
    const results = pages.map((p, i) =>
      capture.commitPage("j1", lease, T0, { ...p, gaps: i === 3 ? 2 : 0 }),
    );
    expect(results.at(-1)).toMatchObject({ ended: true, outcome: "partial" });
    expect(results.slice(0, -1).every((r) => r.outcome === "continue")).toBe(true);
    const job = jobs.get("j1");
    expect(job.state).toBe("partial");
    expect(job.stopReason).toMatch(/2 gaps/);
    expect(job.leaseOwner).toBeNull();
  });

  it("completes a pass without gaps", () => {
    const { jobs, capture, lease } = setup();
    const results = allPages("p1").map((p) =>
      capture.commitPage("j1", lease, T0, { ...p, gaps: 0 }),
    );
    expect(results.at(-1)).toMatchObject({ ended: true, outcome: "complete" });
    expect(jobs.get("j1").state).toBe("complete");
  });

  it("counts gaps per pass, so a later clean pass may complete", () => {
    const { jobs, capture, lease } = setup();
    for (const p of allPages("p1")) capture.commitPage("j1", lease, T0, { ...p, gaps: 1 });
    expect(jobs.get("j1").state).toBe("partial");
    jobs.resume("j1");
    const again = jobs.acquire("j1", "B", T0, TTL)!;
    const last = allPages("p2")
      .map((p) => capture.commitPage("j1", again, T0, p))
      .at(-1);
    expect(last?.outcome).toBe("complete");
    expect(jobs.get("j1").state).toBe("complete");
  });

  it("does not count a gap twice when a page is replayed", () => {
    const { jobs, capture, lease } = setup();
    const first = { ...pageAt("p1", 0), gaps: 1 };
    capture.commitPage("j1", lease, T0, first);
    capture.commitPage("j1", lease, T0, first);
    for (const p of allPages("p1").slice(1)) capture.commitPage("j1", lease, T0, p);
    expect(jobs.get("j1").stopReason).toMatch(/1 gaps/);
  });

  it("rejects an invalid gap count", () => {
    const { capture, lease } = setup();
    expect(() => capture.commitPage("j1", lease, T0, { ...pageAt("p1", 0), gaps: -1 })).toThrow(
      /gaps/,
    );
  });
});

describe("cursor loops are refused (CAP-04)", () => {
  it("refuses a page whose continuation returns to a cursor this pass already read", () => {
    const { db, jobs, capture, lease } = setup();
    for (const p of allPages("p1").slice(0, 3)) capture.commitPage("j1", lease, T0, p);
    const sources = count(db, "source");
    const looping = { ...pageAt("p1", 3), cursorOut: cursorFor("p1", 1) };
    expect(() => capture.commitPage("j1", lease, T0, looping)).toThrow(CursorLoopError);
    expect(count(db, "source")).toBe(sources);
    expect(jobs.get("j1").cursor).toBe(pageAt("p1", 2).cursorOut);
    expect(jobs.get("j1").state).toBe("running");
  });

  it("refuses a page that continues at its own cursor", () => {
    const { capture, lease } = setup();
    capture.commitPage("j1", lease, T0, pageAt("p1", 0));
    const self = { ...pageAt("p1", 1), cursorOut: cursorFor("p1", 1) };
    expect(() => capture.commitPage("j1", lease, T0, self)).toThrow(CursorLoopError);
  });
});
