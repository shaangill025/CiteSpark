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
  type Lease,
} from "./index.ts";

const setup = () => {
  const db = new Database(":memory:");
  migrate(db);
  return { db, jobs: new JobStore(db) };
};
const mk = (jobs: JobStore, id: string, collection = "c1") =>
  jobs.create({ id, kind: "capture", accountId: "a1", collectionId: collection });

const acquired = (jobs: JobStore, id: string, owner: string, nowMs: number, ttlMs: number) => {
  const token = jobs.acquire(id, owner, nowMs, ttlMs);
  if (!token) throw new Error(`expected ${owner} to acquire ${id}`);
  return token;
};

describe("lease", () => {
  it("returns the acquisition token atomically rather than rereading a newer lease", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    const first = jobs.acquire("j1", "A", 0, 1000);
    const second = jobs.acquire("j1", "A", 1001, 1000);
    expect(first).toEqual({ owner: "A", generation: 1 });
    expect(second).toEqual({ owner: "A", generation: 2 });
  });

  it("fences an earlier acquisition even when the owner ID is reused", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    const stale = jobs.acquire("j1", "A", 0, 1000)!;
    const current = jobs.acquire("j1", "A", 1001, 1000)!;
    expect(current.generation).toBeGreaterThan(stale.generation);
    expect(() => jobs.renew("j1", stale, 1002, 1000)).toThrow(LeaseError);
    expect(() => jobs.checkpoint("j1", stale, 1002, { cursor: "stale" })).toThrow(LeaseError);
    expect(() => jobs.transition("j1", stale, 1002, "complete")).toThrow(LeaseError);
    jobs.checkpoint("j1", current, 1002, { cursor: "current" });
    expect(jobs.get("j1").cursor).toBe("current");
  });

  it("rejects overlapping owners for the same collection and allows others", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    mk(jobs, "j2");
    mk(jobs, "j3", "c2");
    expect(jobs.acquire("j1", "A", 0, 60_000)).not.toBeNull();
    expect(jobs.acquire("j1", "B", 1, 60_000)).toBeNull();
    expect(jobs.acquire("j2", "B", 1, 60_000)).toBeNull();
    expect(jobs.acquire("j3", "B", 1, 60_000)).not.toBeNull();
  });

  it("renews, expires, and lets a new owner take over; the old owner is fenced", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    const a = acquired(jobs, "j1", "A", 0, 60_000);
    jobs.renew("j1", a, 20_000, 60_000);
    expect(jobs.acquire("j1", "B", 70_000, 60_000)).toBeNull();
    expect(jobs.findExpired(80_001)).toHaveLength(1);
    expect(jobs.acquire("j1", "B", 80_001, 60_000)).not.toBeNull();
    expect(() => jobs.renew("j1", a, 80_002, 60_000)).toThrow(LeaseError);
    expect(() => jobs.checkpoint("j1", a, 80_002, { cursor: "x" })).toThrow(LeaseError);
    expect(() => jobs.transition("j1", a, 80_002, "complete")).toThrow(LeaseError);
  });

  it("rejects overlapping jobs even when they use the same owner ID", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    mk(jobs, "j2");
    jobs.acquire("j1", "A", 0, 1000);
    expect(jobs.acquire("j2", "A", 1, 1000)).toBeNull();
  });

  it("does not restart cancelled work when its owner crashes before acknowledging cancel", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    jobs.acquire("j1", "A", 0, 1000);
    jobs.cancel("j1", 1);
    expect(jobs.acquire("j1", "B", 1001, 1000)).toBeNull();
    expect(jobs.get("j1")).toMatchObject({ state: "cancelled", leaseOwner: null });
  });

  it("cannot renew after expiry", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    const a = acquired(jobs, "j1", "A", 0, 1000);
    expect(() => jobs.renew("j1", a, 1000, 1000)).toThrow(LeaseError);
  });
});

describe("time and TTL validation", () => {
  const MAX = Number.MAX_SAFE_INTEGER;
  const badTimes = [Number.NaN, Infinity, -Infinity, 1.5, -1, MAX + 1];
  const badTtls = [Number.NaN, Infinity, 0, -1, -1000, 1.5, MAX + 1];

  it.each(badTtls)("acquire rejects TTL %s without leasing the job", (ttl) => {
    const { jobs } = setup();
    mk(jobs, "j1");
    const before = jobs.get("j1");
    expect(() => jobs.acquire("j1", "A", 0, ttl)).toThrow(RangeError);
    expect(jobs.get("j1")).toEqual(before);
  });

  it.each(badTimes)("acquire rejects time %s without leasing or cancelling", (now) => {
    const { jobs } = setup();
    mk(jobs, "j1");
    mk(jobs, "j2");
    const held = jobs.acquire("j1", "A", 0, 1000)!;
    jobs.cancel("j1", 1);
    const before = [jobs.get("j1"), jobs.get("j2")];
    expect(() => jobs.acquire("j2", "B", now, 1000)).toThrow(RangeError);
    expect(() => jobs.acquire("j1", "B", now, 1000)).toThrow(RangeError);
    expect([jobs.get("j1"), jobs.get("j2")]).toEqual(before);
    expect(jobs.checkpoint("j1", held, 2, {})).toBe(true);
  });

  it("acquire rejects an expiration beyond the safe integer range", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    expect(() => jobs.acquire("j1", "A", MAX - 10, 11)).toThrow(RangeError);
    expect(jobs.get("j1")).toMatchObject({ state: "queued", leaseGeneration: 0 });
    expect(jobs.acquire("j1", "A", MAX - 10, 10)).toEqual({ owner: "A", generation: 1 });
  });

  it("a rejected negative TTL cannot open a same-scope overlap", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    mk(jobs, "j2");
    expect(() => jobs.acquire("j1", "A", 1000, -500)).toThrow(RangeError);
    expect(jobs.acquire("j2", "B", 1000, 1000)).not.toBeNull();
    expect(jobs.acquire("j1", "A", 1001, 1000)).toBeNull();
  });

  it.each([...badTimes.map((t) => [t, 1000]), ...badTtls.map((t) => [500, t]), [MAX - 10, 11]])(
    "renew rejects time %s / TTL %s without changing the lease",
    (now, ttl) => {
      const { jobs } = setup();
      mk(jobs, "j1");
      const held = jobs.acquire("j1", "A", 0, 1000)!;
      const before = jobs.get("j1");
      expect(() => jobs.renew("j1", held, now!, ttl!)).toThrow(RangeError);
      expect(jobs.get("j1")).toEqual(before);
    },
  );

  it.each(badTimes)("checkpoint rejects time %s, including after expiry", (now) => {
    const { jobs } = setup();
    mk(jobs, "j1");
    const held = jobs.acquire("j1", "A", 0, 1000)!;
    jobs.checkpoint("j1", held, 1, { cursor: "committed" });
    expect(() => jobs.checkpoint("j1", held, now, { cursor: "late" })).toThrow(RangeError);
    expect(jobs.get("j1").cursor).toBe("committed");
  });

  it.each(badTimes)("transition rejects time %s, including after expiry", (now) => {
    const { jobs } = setup();
    mk(jobs, "j1");
    const held = jobs.acquire("j1", "A", 0, 1000)!;
    const before = jobs.get("j1");
    expect(() => jobs.transition("j1", held, now, "complete")).toThrow(RangeError);
    expect(jobs.get("j1")).toEqual(before);
  });

  it.each(badTimes)("cancel rejects time %s instead of bypassing a live lease", (now) => {
    const { jobs } = setup();
    mk(jobs, "j1");
    jobs.acquire("j1", "A", 0, 1000);
    const before = jobs.get("j1");
    expect(() => jobs.cancel("j1", now)).toThrow(RangeError);
    expect(jobs.get("j1")).toEqual(before);
  });

  it.each(badTimes)("findExpired rejects time %s", (now) => {
    const { jobs } = setup();
    mk(jobs, "j1");
    jobs.acquire("j1", "A", 0, 1000);
    expect(() => jobs.findExpired(now)).toThrow(RangeError);
  });
});

describe("checkpoints", () => {
  it("persist across a reopened store and survive owner takeover", () => {
    const { db, jobs } = setup();
    mk(jobs, "j1");
    const a = acquired(jobs, "j1", "A", 0, 1000);
    jobs.checkpoint("j1", a, 1, {
      cursor: "cur-1",
      checkpoint: '{"page":1}',
      progress: "1",
    });
    jobs.checkpoint("j1", a, 2, { progress: "2" });
    const again = new JobStore(db).get("j1");
    expect(again).toMatchObject({ cursor: "cur-1", checkpoint: '{"page":1}', progress: "2" });
    jobs.acquire("j1", "B", 5000, 1000);
    expect(jobs.get("j1").cursor).toBe("cur-1");
  });
});

describe("state machine", () => {
  it.each([
    "queued",
    "paused",
    "auth_required",
    "rate_limited",
    "partial",
    "failed",
    "complete",
  ] as const)("honors pending cancellation instead of transitioning to %s", (state) => {
    const { jobs } = setup();
    mk(jobs, "j1");
    const a = acquired(jobs, "j1", "A", 0, 1000);
    jobs.checkpoint("j1", a, 1, { cursor: "committed" });
    jobs.cancel("j1", 2);
    jobs.transition("j1", a, 3, state, "other outcome");
    expect(jobs.get("j1")).toMatchObject({
      state: "cancelled",
      stopReason: "cancelled by user",
      cursor: "committed",
      leaseOwner: null,
    });
    expect(jobs.acquire("j1", "B", 4, 1000)).toBeNull();
  });

  it("rejects resume of a running job without releasing its lease", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    jobs.acquire("j1", "A", 0, 1000);
    const before = jobs.get("j1");
    expect(() => jobs.resume("j1")).toThrow(InvalidTransitionError);
    expect(jobs.get("j1")).toEqual(before);
    expect(jobs.acquire("j1", "B", 1, 1000)).toBeNull();
  });

  it("records stop reason, releases the lease, and resumes paused jobs", () => {
    const { jobs } = setup();
    mk(jobs, "j1");
    const a = acquired(jobs, "j1", "A", 0, 1000);
    jobs.transition("j1", a, 1, "rate_limited", "429 Retry-After 30");
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
    const first = acquired(jobs, "j1", "A", 0, 1000);
    jobs.transition("j1", first, 1, "failed", "bad payload");
    jobs.resume("j1");
    expect(jobs.get("j1").retryCount).toBe(1);
    expect(() => jobs.resume("j1")).toThrow(InvalidTransitionError);
    const second = acquired(jobs, "j1", "A", 2, 1000);
    expect(() => jobs.transition("j1", first, 3, "complete")).toThrow(LeaseError);
    jobs.transition("j1", second, 3, "complete");
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
    const a = acquired(jobs, "j1", "A", 0, 1000);
    expect(jobs.cancel("j1", 1).state).toBe("running");
    expect(jobs.checkpoint("j1", a, 2, { cursor: "c" })).toBe(true);
    jobs.transition("j1", a, 3, "cancelled");
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
    for (let seed = 1; seed <= 50; seed++) {
      const rnd = prng(seed);
      const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
      const { jobs } = setup();
      const ids = ["j1", "j2", "j3"];
      ids.forEach((id) => mk(jobs, id, id === "j3" ? "c2" : "c1"));
      const owners = ["A", "B"];
      // Each worker keeps only the token its own acquire returned; generation 0 is never leased.
      const tokens = new Map<string, Lease>();
      const lease = (id: string, owner: string): Lease =>
        tokens.get(`${id}/${owner}`) ?? { owner, generation: 0 };
      let now = 0;
      for (let step = 0; step < 60; step++) {
        now += Math.floor(rnd() * 400);
        const id = pick(ids);
        const owner = pick(owners);
        const before = jobs.get(id).state;
        try {
          switch (Math.floor(rnd() * 7)) {
            case 0: {
              const token = jobs.acquire(id, owner, now, 1000);
              if (token) tokens.set(`${id}/${owner}`, token);
              break;
            }
            case 1:
              jobs.renew(id, lease(id, owner), now, 1000);
              break;
            case 2:
              jobs.checkpoint(id, lease(id, owner), now, { cursor: String(step) });
              break;
            case 3:
              jobs.transition(id, lease(id, owner), now, pick(JOB_STATES) as JobState);
              break;
            case 4:
              jobs.resume(id);
              break;
            case 5:
              jobs.cancel(id, now);
              break;
            default:
              jobs.transition(
                id,
                lease(id, owner),
                now,
                pick(["paused", "partial", "complete"] as const),
              );
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
        expect(live.length).toBeLessThanOrEqual(1);
        for (const j of ids.map((x) => jobs.get(x))) {
          if (j.state !== "running") expect(j.leaseOwner).toBeNull();
        }
      }
    }
  }, 30_000);
});
