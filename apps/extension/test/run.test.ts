import { describe, expect, test } from "vitest";
import { RequestError, TransportClosedError } from "@citspark/ipc";
import type {
  CapturePagePayload,
  CapturePageResult,
  CaptureStartResult,
  CaptureStopPayload,
} from "@citspark/protocol";
import { CaptureStopPayloadSchema } from "@citspark/protocol";
import { CaptureRun, type DesktopApi, type Observation } from "../src/background/run.ts";
import { DailyBudget, memoryKv, TEST_PACING } from "../src/background/pacer.ts";
import {
  OTHER_ACCOUNT,
  SYNTH_ACCOUNT,
  bookmarksBody,
  linearCollection,
  viewerBody,
  type PageSpec,
} from "./mock-x/bodies.ts";

class FakeTimers {
  now = 1_800_000_000_000;
  #q: { at: number; fn: () => void; id: number }[] = [];
  #id = 0;
  set = (fn: () => void, ms: number) => {
    const id = ++this.#id;
    this.#q.push({ at: this.now + ms, fn, id });
    return id;
  };
  clear = (id: unknown) => {
    this.#q = this.#q.filter((t) => t.id !== id);
  };
  async advance(ms: number) {
    const end = this.now + ms;
    for (;;) {
      this.#q.sort((a, b) => a.at - b.at);
      const t = this.#q[0];
      if (!t || t.at > end) break;
      this.#q.shift();
      this.now = t.at;
      t.fn();
      await flush();
    }
    this.now = end;
    await flush();
  }
}

const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

type PageReply = CapturePageResult | Error | (() => Promise<CapturePageResult>);

function harness(opts: { resumed?: boolean; replies?: PageReply[]; budget?: number } = {}) {
  const timers = new FakeTimers();
  const pages: { p: CapturePagePayload; id: string }[] = [];
  const stops: CaptureStopPayload[] = [];
  const replies = [...(opts.replies ?? [])];
  let seq = 0;
  const desktop: DesktopApi = {
    start: async (): Promise<CaptureStartResult> => ({
      jobId: "job-1",
      passId: "pass-1",
      resumed: opts.resumed ?? false,
      committedPages: opts.resumed ? 2 : 0,
    }),
    page: async (p, id) => {
      pages.push({ p, id });
      const r = replies.shift();
      if (r instanceof Error) throw r;
      if (typeof r === "function") return r();
      return (
        r ?? {
          status: "committed",
          seq: seq++,
          outcome:
            p.cursorOut === null ? (p.gaps.unavailable ? "partial" : "complete") : "continue",
          newRecords: p.records.length,
        }
      );
    },
    stop: async (p) => {
      // The desktop refuses a stop that does not name the exact pass it ends (Sol review).
      if (!CaptureStopPayloadSchema.safeParse(p).success)
        throw new Error("invalid capture.stop payload");
      stops.push(p);
      return { state: p.outcome };
    },
  };
  let scrolls = 0;
  const kv = memoryKv();
  const budget = new DailyBudget(TEST_PACING, kv);
  const run = new CaptureRun({
    collection: { kind: "bookmarks" },
    accountId: SYNTH_ACCOUNT,
    desktop,
    tab: { scroll: () => void scrolls++ },
    timers: { set: timers.set, clear: timers.clear },
    now: () => timers.now,
    random: () => 0.5,
    pacing: TEST_PACING,
    budget,
  });
  const page = (spec: PageSpec, cursor: string | null, extra: Partial<Observation> = {}) =>
    run.observe({
      kind: "page",
      collection: "bookmarks",
      cursor,
      status: 200,
      retryAfter: null,
      body: JSON.stringify(bookmarksBody(spec)),
      tooLarge: false,
      ...extra,
    } as Observation);
  const status = (code: number, cursor: string | null, retryAfter: string | null = null) =>
    run.observe({
      kind: "page",
      collection: "bookmarks",
      cursor,
      status: code,
      retryAfter,
      body: null,
      tooLarge: false,
    });
  return {
    run,
    timers,
    pages,
    stops,
    budget,
    page,
    status,
    get scrolls() {
      return scrolls;
    },
  };
}

const C = linearCollection(3, 2);

describe("passive capture run (ADR 0005, CAP-03, CAP-05)", () => {
  test("commits each page, scrolls only after the desktop acknowledged it, and completes", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const h = harness({
      replies: [
        async () => {
          await gate;
          return { status: "committed", seq: 0, outcome: "continue", newRecords: 2 };
        },
      ],
    });
    await h.run.begin();
    const first = h.page(C[0]!, null);
    await h.timers.advance(10_000);
    expect(h.scrolls).toBe(0); // no ack yet, so no cursor progress
    release();
    await first;
    expect(h.scrolls).toBe(0);
    await h.timers.advance(TEST_PACING.maxDelayMs);
    expect(h.scrolls).toBe(1);
    await h.page(C[1]!, C[0]!.next);
    await h.timers.advance(TEST_PACING.maxDelayMs);
    await h.page(C[2]!, C[1]!.next);
    expect(h.pages.map((x) => [x.p.cursorIn, x.p.cursorOut, x.id])).toEqual([
      [null, C[0]!.next, "pass-1:0"],
      [C[0]!.next, C[1]!.next, "pass-1:1"],
      [C[1]!.next, null, "pass-1:2"],
    ]);
    expect(h.pages[0]!.p).toMatchObject({ jobId: "job-1", accountId: SYNTH_ACCOUNT });
    expect(h.run.status.state).toBe("complete");
    expect(h.stops).toEqual([]);
  });

  test("ignores other collections, unexpected cursors, and duplicates", async () => {
    const h = harness();
    await h.run.begin();
    await h.run.observe({
      kind: "page",
      collection: "likes",
      cursor: null,
      status: 200,
      retryAfter: null,
      body: "{}",
      tooLarge: false,
    });
    await h.page(C[1]!, "SOME_OTHER_CURSOR");
    expect(h.pages).toHaveLength(0);
    await h.page(C[0]!, null);
    await h.page(C[0]!, null);
    expect(h.pages).toHaveLength(1);
  });

  test("unrelated responses arriving as a timer fires never stall the pass", async () => {
    const h = harness();
    await h.run.begin();
    await h.page(C[0]!, null);
    // Queue an unrelated response, then let the scroll timer fire before it is handled.
    const other = h.run.observe({
      kind: "page",
      collection: "likes",
      cursor: null,
      status: 200,
      retryAfter: null,
      body: "{}",
      tooLarge: false,
    });
    await h.timers.advance(TEST_PACING.maxDelayMs + TEST_PACING.minDelayMs + 10);
    await other;
    await h.timers.advance(TEST_PACING.maxDelayMs);
    expect(h.scrolls).toBeGreaterThanOrEqual(1);
  });

  test("an auth failure stops as auth_required, never complete", async () => {
    const h = harness();
    await h.run.begin();
    await h.status(401, null);
    expect(h.stops).toEqual([
      { jobId: "job-1", passId: "pass-1", outcome: "auth_required", reason: "auth_required" },
    ]);
    expect(h.run.status.state).toBe("auth_required");
  });

  test("429 waits at least Retry-After, then scrolls again", async () => {
    const h = harness();
    await h.run.begin();
    await h.page(C[0]!, null);
    await h.timers.advance(TEST_PACING.maxDelayMs);
    expect(h.scrolls).toBe(1);
    await h.status(429, C[0]!.next, "3");
    expect(h.run.status.state).toBe("backing_off");
    await h.timers.advance(2900);
    expect(h.scrolls).toBe(1);
    await h.timers.advance(200);
    expect(h.scrolls).toBe(2);
    await h.page(C[1]!, C[0]!.next);
    expect(h.run.status.state).toBe("capturing");
  });

  test("repeated 429s stop the job as rate limited with the server's delay", async () => {
    const h = harness();
    await h.run.begin();
    for (let i = 0; i <= TEST_PACING.maxRateLimitRetries; i++) {
      await h.status(429, null, "2");
      await h.timers.advance(TEST_PACING.maxBackoffMs + 2000);
    }
    expect(h.stops).toEqual([
      {
        jobId: "job-1",
        passId: "pass-1",
        outcome: "rate_limited",
        reason: "rate_limited",
        retryAfterSec: 2,
      },
    ]);
  });

  test("a Retry-After too long to hold stops at once", async () => {
    const h = harness();
    await h.run.begin();
    await h.status(429, null, "3600");
    expect(h.stops[0]).toMatchObject({ outcome: "rate_limited", retryAfterSec: 3600 });
  });

  test("an unsupported schema pauses capture honestly (CAP-07)", async () => {
    const h = harness();
    await h.run.begin();
    await h.page({ posts: [1], next: "N", unsupported: true }, null);
    expect(h.stops).toEqual([
      { jobId: "job-1", passId: "pass-1", outcome: "paused", reason: "unsupported_schema" },
    ]);
    expect(h.pages).toHaveLength(0);
  });

  test("an oversized response pauses without parsing", async () => {
    const h = harness();
    await h.run.begin();
    await h.page(C[0]!, null, { tooLarge: true, body: null });
    expect(h.stops[0]).toMatchObject({ outcome: "paused", reason: "response_too_large" });
  });

  test.each([
    ["disk_full", "paused"],
    ["cursor_loop", "failed"],
    ["checkpoint_corrupt", "failed"],
    ["account_mismatch", "paused"],
  ])("desktop %s ends the run as %s without scrolling", async (code, state) => {
    const h = harness({ replies: [new RequestError({ code: code as never, message: "x" })] });
    await h.run.begin();
    await h.page(C[0]!, null);
    await h.timers.advance(60_000);
    expect(h.run.status).toMatchObject({ state, reason: code });
    expect(h.scrolls).toBe(0);
    expect(h.stops).toEqual([]);
  });

  test("a lost desktop connection never ends as complete", async () => {
    const h = harness({ replies: [new TransportClosedError()] });
    await h.run.begin();
    await h.page(C[0]!, null);
    await h.timers.advance(60_000);
    expect(h.run.status.state).toBe("desktop_unavailable");
    expect(h.scrolls).toBe(0);
  });

  test("a pass with gaps ends partial", async () => {
    const h = harness();
    await h.run.begin();
    await h.page({ posts: [1], next: null, tombstone: true }, null);
    expect(h.pages[0]!.p.gaps.unavailable).toBe(1);
    expect(h.run.status.state).toBe("partial");
  });

  test("no response after repeated scrolls pauses with no_progress (ambiguous end)", async () => {
    const h = harness();
    await h.run.begin();
    await h.page(C[0]!, null);
    await h.timers.advance(
      TEST_PACING.maxDelayMs + TEST_PACING.noProgressMs * (TEST_PACING.maxNoProgressScrolls + 2),
    );
    expect(h.stops).toEqual([
      { jobId: "job-1", passId: "pass-1", outcome: "paused", reason: "no_progress" },
    ]);
  });

  test("pause and cancel stop new work; later responses are ignored", async () => {
    const h = harness();
    await h.run.begin();
    await h.run.pause();
    await h.page(C[0]!, null);
    expect(h.pages).toHaveLength(0);
    expect(h.stops).toEqual([
      { jobId: "job-1", passId: "pass-1", outcome: "paused", reason: "user_pause" },
    ]);
    const c = harness();
    await c.run.begin();
    await c.run.cancel();
    expect(c.stops).toEqual([
      { jobId: "job-1", passId: "pass-1", outcome: "cancelled", reason: "user_cancel" },
    ]);
    expect(c.run.status.state).toBe("cancelled");
  });

  test("the daily budget pauses before the next scroll", async () => {
    const h = harness();
    await h.budget.setLimit(1);
    await h.run.begin(); // the initial page load spends the one page
    await h.page(C[0]!, null);
    await h.timers.advance(TEST_PACING.maxDelayMs);
    expect(h.scrolls).toBe(0);
    expect(h.stops).toEqual([
      { jobId: "job-1", passId: "pass-1", outcome: "paused", reason: "daily_budget" },
    ]);
  });

  test("a resumed job reports catching up until it reaches new records", async () => {
    const h = harness({
      resumed: true,
      replies: [
        { status: "committed", seq: 0, outcome: "continue", newRecords: 0 },
        { status: "committed", seq: 1, outcome: "continue", newRecords: 2 },
      ],
    });
    await h.run.begin();
    expect(h.run.status.state).toBe("catching_up");
    await h.page(C[0]!, null);
    expect(h.run.status.state).toBe("catching_up");
    await h.timers.advance(TEST_PACING.maxDelayMs);
    await h.page(C[1]!, C[0]!.next);
    expect(h.run.status.state).toBe("capturing");
  });

  test("an account switch in the tab pauses before anything else is merged (CAP-02)", async () => {
    const h = harness();
    await h.run.begin();
    await h.run.observe({
      kind: "viewer",
      status: 200,
      body: JSON.stringify(viewerBody(OTHER_ACCOUNT, "synth_mallory")),
      tooLarge: false,
    });
    await h.page(C[0]!, null);
    expect(h.pages).toHaveLength(0);
    expect(h.stops).toEqual([
      { jobId: "job-1", passId: "pass-1", outcome: "paused", reason: "account_mismatch" },
    ]);
  });

  test("closing the X tab pauses the job", async () => {
    const h = harness();
    await h.run.begin();
    await h.run.tabClosed();
    expect(h.stops).toEqual([
      { jobId: "job-1", passId: "pass-1", outcome: "paused", reason: "tab_closed" },
    ]);
  });
});
