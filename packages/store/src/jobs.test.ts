import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  InvalidTransitionError,
  JOB_STATES,
  JobStore,
  LeaseError,
  TERMINAL_STATES,
  TRANSITIONS,
  migrate,
  type JobState,
} from "./index.ts";

const setup = () => {
  const db = new Database(":memory:");
  migrate(db);
  return { db, jobs: new JobStore(db) };
};
const mk = (jobs: JobStore, id: string, collection = "c1") =>
  jobs.create({ id, kind: "capture", accountId: "a1", collectionId: collection });

describe("lease", () => {
  it("rejects overlapping owners for the same collection and allows others", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    mk(jobs, "j2");
    mk(jobs, "j3", "c2");
    expect(jobs.acquire("j1", "A", 0, 60_000)).toBe(true);
    expect(jobs.acquire("j1", "B", 1, 60_000)).toBe(false);
    expect(jobs.acquire("j2", "B", 1, 60_000)).toBe(false);
    expect(jobs.acquire("j3", "B", 1, 60_000)).toBe(true);
  });

  it("renews, expires, and lets a new owner take over; the old owner is fenced", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    jobs.acquire("j1", "A", 0, 60_000);
    jobs.renew("j1", "A", 20_000, 60_000);
    expect(jobs.acquire("j1", "B", 70_000, 60_000)).toBe(false);
    expect(jobs.findExpired(80_001)).toHaveLength(1);
    expect(jobs.acquire("j1", "B", 80_001, 60_000)).toBe(true);
    expect(() => jobs.renew("j1", "A", 80_002, 60_000)).toThrow(LeaseError);
    expect(() => jobs.checkpoint("j1", "A", 80_002, { cursor: "x" })).toThrow(LeaseError);
    expect(() => jobs.transition("j1", "A", 80_002, "complete")).toThrow(LeaseError);
  });

  it("cannot renew after expiry", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    jobs.acquire("j1", "A", 0, 1000);
    expect(() => jobs.renew("j1", "A", 1000, 1000)).toThrow(LeaseError);
  });
});

describe("checkpoints", () => {
  it("persist across a reopened store and survive owner takeover", () => {
    const { db, jobs } = setup();
    mk(jobs, "j1");
    jobs.acquire("j1", "A", 0, 1000);
    jobs.checkpoint("j1", "A", 1, { cursor: "cur-1", checkpoint: '{"page":1}', progress: "1" });
    jobs.checkpoint("j1", "A", 2, { progress: "2" });
    const again = new JobStore(db).get("j1");
    expect(again).toMatchObject({ cursor: "cur-1", checkpoint: '{"page":1}', progress: "2" });
    jobs.acquire("j1", "B", 5000, 1000);
    expect(jobs.get("j1").cursor).toBe("cur-1");
  });
});

describe("state machine", () => {
  it("records stop reason, releases the lease, and resumes paused jobs", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    jobs.acquire("j1", "A", 0, 1000);
    jobs.transition("j1", "A", 1, "rate_limited", "429 Retry-After 30");
    expect(jobs.get("j1")).toMatchObject({
      state: "rate_limited",
      stopReason: "429 Retry-After 30",
      leaseOwner: null,
    });
    jobs.resume("j1");
    expect(jobs.get("j1").state).toBe("queued");
  });

  it("counts retries of failed jobs and rejects illegal transitions", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    jobs.acquire("j1", "A", 0, 1000);
    jobs.transition("j1", "A", 1, "failed", "bad payload");
    jobs.resume("j1");
    expect(jobs.get("j1").retryCount).toBe(1);
    expect(() => jobs.resume("j1")).toThrow(InvalidTransitionError);
    jobs.acquire("j1", "A", 2, 1000);
    jobs.transition("j1", "A", 3, "complete");
    expect(() => jobs.resume("j1")).toThrow(InvalidTransitionError);
    expect(() => jobs.cancel("j1", 4)).toThrow(InvalidTransitionError);
  });

  it("cancel keeps committed records and defers to a live owner", () => {
    const { db, jobs } = setup();
    mk(jobs, "j1");
    db.prepare("INSERT INTO source (id, source_type) VALUES ('s1', 'post')").run();
    db.prepare(
      "INSERT INTO source_version (source_id, content_hash, text) VALUES ('s1','h','t')",
    ).run();
    db.prepare(
      "INSERT INTO observation (source_id, version_id, job_id, method) VALUES ('s1', 1, 'j1', 'capture')",
    ).run();
    jobs.acquire("j1", "A", 0, 1000);
    expect(jobs.cancel("j1", 1).state).toBe("running");
    expect(jobs.checkpoint("j1", "A", 2, { cursor: "c" })).toBe(true);
    jobs.transition("j1", "A", 3, "cancelled");
    expect(jobs.get("j1").state).toBe("cancelled");
    expect(db.prepare("SELECT COUNT(*) n FROM observation WHERE job_id='j1'").get()).toEqual({
      n: 1,
    });
    expect(db.prepare("SELECT COUNT(*) n FROM source_version").get()).toEqual({ n: 1 });
  });

  it("cancels queued jobs and jobs with expired leases immediately", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    mk(jobs, "j2", "c2");
    expect(jobs.cancel("j1", 0).state).toBe("cancelled");
    jobs.acquire("j2", "A", 0, 1000);
    expect(jobs.cancel("j2", 2000).state).toBe("cancelled");
  });
});

describe("property: random operation sequences", () => {
  const prng = (seed: number) => () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };

  it("always end in a valid state with at most one live lease per collection", () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rnd = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const { jobs } = setup();
      const ids = ["j1", "j2", "j3"];
      ids.forEach((id) => mk(jobs, id, id === "j3" ? "c2" : "c1"));
      const owners = ["A", "B"];
      let now = 0;
      for (let step = 0; step < 60; step++) {
        now += Math.floor(rnd() * 400);
        const id = pick(ids);
        const owner = pick(owners);
        const before = jobs.get(id).state;
        try {
          switch (Math.floor(rnd() * 7)) {
            case 0:
              jobs.acquire(id, owner, now, 1000);
              break;
            case 1:
              jobs.renew(id, owner, now, 1000);
              break;
            case 2:
              jobs.checkpoint(id, owner, now, { cursor: String(step) });
              break;
            case 3:
              jobs.transition(id, owner, now, pick(JOB_STATES) as JobState);
              break;
            case 4:
              jobs.resume(id);
              break;
            case 5:
              jobs.cancel(id, now);
              break;
            default:
              jobs.transition(id, owner, now, pick(["paused", "partial", "complete"] as const));
          }
        } catch (e) {
          expect(e instanceof InvalidTransitionError || e instanceof LeaseError).toBe(true);
        }
        const after = jobs.get(id).state;
        expect(JOB_STATES).toContain(after);
        if (after !== before) {
          const legal =
            TRANSITIONS[before].includes(after) || (before === "running" && after === "running");
          expect(legal).toBe(true);
        }
        if (TERMINAL_STATES.includes(before)) expect(after).toBe(before);
        const live = ["j1", "j2"]
          .map((j) => jobs.get(j))
          .filter((j) => j.leaseOwner !== null && j.leaseExpiresAt! > now);
        expect(new Set(live.map((j) => j.leaseOwner)).size).toBeLessThanOrEqual(1);
        for (const j of ids.map((x) => jobs.get(x))) {
          if (j.state !== "running") expect(j.leaseOwner).toBeNull();
        }
      }
    }
  });
});
