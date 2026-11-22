// Desktop side of capture (M1-08): the core commits pages the extension hands over. Synthetic data only.
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { CaptureMethod, ErrorCode, ProtocolException, Scope } from "@citspark/protocol";
import { JobStore, migrate } from "@citspark/store";
import { captureHandlers } from "./capture-ipc.ts";
import type { PairedClient } from "./ipc/registry.ts";

const ACCOUNT = "7000000000000000001";
const ADAPTER = { id: "x-web", version: "1.0.0" };

const client = (id: string): PairedClient => ({
  id,
  kind: "extension",
  publicKey: new Uint8Array(32),
  scopes: [Scope.CaptureWrite],
  createdAt: "2026-01-01T00:00:00.000Z",
});
const ext = client("ext-1");

const rec = (n: number) => ({
  sourceType: "x_post" as const,
  platformId: `19000000000000${String(n).padStart(5, "0")}`,
  text: `Synthetic post ${n}`,
  authorId: "7000000000000000002",
  authorHandle: "synth_bob",
  canonicalUrl: `https://x.com/synth_bob/status/19000000000000${String(n).padStart(5, "0")}`,
  publishedAt: "2025-01-01T00:00:00.000Z",
});

function setup(db = new Database(":memory:")) {
  migrate(db);
  let t = 1_800_000_000_000;
  let n = 0;
  const h = captureHandlers({ db, now: () => (t += 1000), newId: () => `id-${++n}` });
  const call = async (method: string, payload: unknown, who = ext) => {
    const handler = h[method];
    if (!handler) throw new Error(`no handler ${method}`);
    expect(handler.scope).toBe(Scope.CaptureWrite);
    expect(handler.mutation).toBe(true);
    return handler.handle(payload as never, { client: who, requestId: `r-${++n}` }) as Promise<
      Record<string, unknown>
    >;
  };
  const count = (table: string) =>
    (db.prepare(`SELECT COUNT(*) n FROM ${table}`).get() as { n: number }).n;
  const job = (id: string) =>
    db.prepare("SELECT state, cursor, stop_reason FROM job WHERE id = ?").get(id) as {
      state: string;
      cursor: string | null;
      stop_reason: string | null;
    };
  /** Moves the injected clock forward, e.g. past a lease's TTL. */
  const advance = (ms: number) => {
    t += ms;
  };
  return { db, call, count, job, advance, now: () => t };
}

const start = (call: ReturnType<typeof setup>["call"], collection = "bookmarks", who = ext) =>
  call(CaptureMethod.start, { accountId: ACCOUNT, collection, adapter: ADAPTER }, who) as Promise<{
    jobId: string;
    passId: string;
    resumed: boolean;
    committedPages: number;
  }>;

function pages(jobId: string, passId: string, n: number, gapsAt = -1) {
  return Array.from({ length: n }, (_, i) => ({
    jobId,
    passId,
    accountId: ACCOUNT,
    collection: "bookmarks",
    cursorIn: i === 0 ? null : `${passId}-c${i}`,
    cursorOut: i === n - 1 ? null : `${passId}-c${i + 1}`,
    adapter: ADAPTER,
    records: [rec(i * 2), rec(i * 2 + 1)],
    gaps: { unavailable: i === gapsAt ? 1 : 0, partialThreads: 0 },
  }));
}

async function rejects(p: Promise<unknown>, code: string) {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(ProtocolException);
  expect((e as ProtocolException).code).toBe(code);
}

describe("capture over IPC: the desktop is the authority (M1-08)", () => {
  test("start binds a new job to the account and collection", async () => {
    const { call, job } = setup();
    const s = await start(call);
    expect(s).toMatchObject({ resumed: false, committedPages: 0 });
    expect(job(s.jobId).state).toBe("running");
  });

  test("commits pages, acknowledges only after commit, and completes at the recognized end", async () => {
    const { call, count, job } = setup();
    const s = await start(call);
    const ps = pages(s.jobId, s.passId, 3);
    const r0 = await call(CaptureMethod.page, ps[0]);
    expect(r0).toEqual({ status: "committed", seq: 0, outcome: "continue", newRecords: 2 });
    expect(job(s.jobId).cursor).toBe(ps[0]!.cursorOut);
    await call(CaptureMethod.page, ps[1]);
    expect(await call(CaptureMethod.page, ps[2])).toMatchObject({ outcome: "complete" });
    expect(job(s.jobId).state).toBe("complete");
    expect(count("source")).toBe(6);
  });

  test("a pass with gaps ends partial, never complete (T02)", async () => {
    const { call, job } = setup();
    const s = await start(call);
    const ps = pages(s.jobId, s.passId, 3, 1);
    for (const p of ps.slice(0, 2)) await call(CaptureMethod.page, p);
    expect(await call(CaptureMethod.page, ps[2])).toMatchObject({ outcome: "partial" });
    expect(job(s.jobId).state).toBe("partial");
  });

  test("a page bound to another account is refused and the job paused (CAP-02)", async () => {
    const { call, count, job } = setup();
    const s = await start(call);
    const p = { ...pages(s.jobId, s.passId, 2)[0], accountId: "7000000000000000999" };
    await rejects(call(CaptureMethod.page, p), ErrorCode.AccountMismatch);
    expect(job(s.jobId).state).toBe("paused");
    expect(count("source")).toBe(0);
  });

  test("a cursor loop fails the job instead of completing it (CAP-04)", async () => {
    const { call, job } = setup();
    const s = await start(call);
    const ps = pages(s.jobId, s.passId, 4);
    await call(CaptureMethod.page, ps[0]);
    await call(CaptureMethod.page, ps[1]);
    await rejects(
      call(CaptureMethod.page, { ...ps[2], cursorOut: ps[1]!.cursorIn }),
      ErrorCode.CursorLoop,
    );
    expect(job(s.jobId).state).toBe("failed");
    expect(job(s.jobId).stop_reason).toMatch(/cursor loop/);
  });

  test("disk exhaustion pauses the job, keeps the cursor, and never completes (CAP-04)", async () => {
    const { db, call, job, count } = setup();
    const s = await start(call);
    const ps = pages(s.jobId, s.passId, 2);
    await call(CaptureMethod.page, ps[0]);
    const cursor = job(s.jobId).cursor;
    const pageCount = (db.pragma("page_count", { simple: true }) as number) + 0;
    db.pragma(`max_page_count = ${pageCount}`);
    const big = {
      ...ps[1],
      records: Array.from({ length: 200 }, (_, i) => ({ ...rec(100 + i), text: "x".repeat(2000) })),
    };
    await rejects(call(CaptureMethod.page, big), ErrorCode.DiskFull);
    db.pragma(`max_page_count = 1073741823`);
    expect(job(s.jobId).cursor).toBe(cursor);
    expect(job(s.jobId).state).toBe("paused");
    expect(job(s.jobId).stop_reason).toMatch(/disk/);
    expect(count("source")).toBe(2);
  });

  test("stop records an honest outcome and releases the job", async () => {
    const { call, job } = setup();
    const s = await start(call);
    expect(
      await call(CaptureMethod.stop, {
        jobId: s.jobId,
        passId: s.passId,
        outcome: "rate_limited",
        reason: "rate_limited",
        retryAfterSec: 90,
      }),
    ).toEqual({ state: "rate_limited" });
    expect(job(s.jobId).stop_reason).toMatch(/rate_limited.*90/);
    await rejects(
      call(CaptureMethod.stop, {
        jobId: s.jobId,
        passId: s.passId,
        outcome: "complete",
        reason: "user_pause",
      }),
      ErrorCode.InvalidMessage,
    );
  });

  test("resume starts a fresh pass from the top; committed pages replay as no-ops", async () => {
    const { call, job, count } = setup();
    const s = await start(call);
    const first = pages(s.jobId, s.passId, 3);
    await call(CaptureMethod.page, first[0]);
    await call(CaptureMethod.stop, {
      jobId: s.jobId,
      passId: s.passId,
      outcome: "paused",
      reason: "user_pause",
    });
    const r = await start(call);
    expect(r).toMatchObject({ jobId: s.jobId, resumed: true, committedPages: 1 });
    expect(r.passId).not.toBe(s.passId);
    const again = pages(r.jobId, r.passId, 3);
    expect(await call(CaptureMethod.page, again[0])).toMatchObject({ newRecords: 0 });
    await call(CaptureMethod.page, again[1]);
    expect(await call(CaptureMethod.page, again[2])).toMatchObject({ outcome: "complete" });
    expect(job(s.jobId).state).toBe("complete");
    expect(count("source")).toBe(6);
  });

  test("a second start while the same client holds the job fences the older pass", async () => {
    const { call } = setup();
    const s = await start(call);
    const r = await start(call);
    expect(r.jobId).toBe(s.jobId);
    await rejects(call(CaptureMethod.page, pages(s.jobId, s.passId, 2)[0]), ErrorCode.LeaseLost);
    await call(CaptureMethod.page, pages(r.jobId, r.passId, 2)[0]);
  });

  test("a delayed stop from a replaced pass never stops its replacement (Sol review)", async () => {
    const { call, job } = setup();
    const a = await start(call);
    const b = await start(call);
    expect(b.passId).not.toBe(a.passId);
    await rejects(
      call(CaptureMethod.stop, {
        jobId: a.jobId,
        passId: a.passId,
        outcome: "cancelled",
        reason: "user_cancel",
      }),
      ErrorCode.LeaseLost,
    );
    expect(job(b.jobId).state).toBe("running");
    await call(CaptureMethod.page, pages(b.jobId, b.passId, 2)[0]);
  });

  test("a cancel from a holder whose expired lease was reclaimed never touches the successor (CAP-03, CAP-04)", async () => {
    const { db, call, job, advance, now } = setup();
    const a = await start(call);
    advance(200_000); // Past the default 120 s TTL: the extension went silent and lost the lease.
    const jobs = new JobStore(db);
    // Another holder of the same library reclaims the expired lease (a newer generation).
    const successor = jobs.acquire(a.jobId, "extension:ext-2", now(), 120_000);
    expect(successor).not.toBeNull();
    // The stale holder's delayed cancel is a typed rejection, not a mutation of the successor's job.
    await rejects(
      call(CaptureMethod.stop, {
        jobId: a.jobId,
        passId: a.passId,
        outcome: "cancelled",
        reason: "user_cancel",
      }),
      ErrorCode.LeaseLost,
    );
    const after = jobs.get(a.jobId);
    expect(after).toMatchObject({
      state: "running",
      cancelRequested: false,
      leaseOwner: "extension:ext-2",
      leaseGeneration: successor!.generation,
    });
    // The successor still ends its own pass with its own outcome, not "cancelled by user".
    jobs.transition(a.jobId, successor!, now(), "paused", "user_pause");
    expect(job(a.jobId)).toMatchObject({ state: "paused", stop_reason: "user_pause" });
  });

  test("a cancel during the final page is never acknowledged as complete (Sol review)", async () => {
    const { db, call, job } = setup();
    const s = await start(call);
    new JobStore(db).cancel(s.jobId, 1_800_000_000_000);
    await rejects(call(CaptureMethod.page, pages(s.jobId, s.passId, 1)[0]), ErrorCode.LeaseLost);
    expect(job(s.jobId).state).toBe("cancelled");
  });

  test("another client cannot commit into or stop a job it does not hold", async () => {
    const { call } = setup();
    const s = await start(call);
    const other = client("ext-2");
    await rejects(
      call(CaptureMethod.page, pages(s.jobId, s.passId, 2)[0], other),
      ErrorCode.LeaseLost,
    );
    await rejects(
      call(
        CaptureMethod.stop,
        { jobId: s.jobId, passId: s.passId, outcome: "paused", reason: "user_pause" },
        other,
      ),
      ErrorCode.LeaseLost,
    );
    await rejects(start(call, "bookmarks", other), ErrorCode.JobBusy);
  });

  test("cancel keeps committed records (CAP-04)", async () => {
    const { call, job, count } = setup();
    const s = await start(call);
    await call(CaptureMethod.page, pages(s.jobId, s.passId, 2)[0]);
    expect(
      await call(CaptureMethod.stop, {
        jobId: s.jobId,
        passId: s.passId,
        outcome: "cancelled",
        reason: "user_cancel",
      }),
    ).toEqual({ state: "cancelled" });
    expect(job(s.jobId).state).toBe("cancelled");
    expect(count("source")).toBe(2);
  });

  test("malformed payloads are refused before any work", async () => {
    const { call } = setup();
    await rejects(
      call(CaptureMethod.start, { accountId: 1, collection: "x" }),
      ErrorCode.InvalidMessage,
    );
  });
});
