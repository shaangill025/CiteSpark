import { describe, expect, test } from "vitest";
import {
  DailyBudget,
  RELEASE_PACING,
  backoffDelay,
  memoryKv,
  nextScrollDelay,
  parseRetryAfter,
} from "../src/background/pacer.ts";

describe("pacer (CAP-05)", () => {
  test("scroll delays are jittered within the conservative release bounds", () => {
    expect(nextScrollDelay(RELEASE_PACING, () => 0)).toBe(RELEASE_PACING.minDelayMs);
    expect(nextScrollDelay(RELEASE_PACING, () => 0.999999)).toBeLessThanOrEqual(
      RELEASE_PACING.maxDelayMs,
    );
    expect(RELEASE_PACING.minDelayMs).toBeGreaterThanOrEqual(2000);
  });

  test("Retry-After accepts seconds and HTTP dates, and rejects junk", () => {
    const now = Date.parse("2026-11-17T00:00:00Z");
    expect(parseRetryAfter("120", now)).toBe(120_000);
    expect(parseRetryAfter("Tue, 17 Nov 2026 00:01:00 GMT", now)).toBe(60_000);
    expect(parseRetryAfter("Mon, 16 Nov 2026 00:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter(null, now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter("-5", now)).toBeNull();
  });

  test("backoff grows, is bounded, and never undercuts Retry-After", () => {
    const r = () => 0.5;
    const a = backoffDelay(RELEASE_PACING, 0, r, null);
    const b = backoffDelay(RELEASE_PACING, 3, r, null);
    expect(b).toBeGreaterThan(a);
    expect(backoffDelay(RELEASE_PACING, 40, r, null)).toBeLessThanOrEqual(
      RELEASE_PACING.maxBackoffMs,
    );
    expect(backoffDelay(RELEASE_PACING, 0, r, 600_000)).toBeGreaterThanOrEqual(600_000);
  });
});

describe("daily page budget (CAP-05)", () => {
  const day1 = new Date(2026, 10, 17, 10).getTime();
  const day2 = new Date(2026, 10, 18, 1).getTime();

  test("refuses pages past the budget and resets on the next local day", async () => {
    const budget = new DailyBudget(RELEASE_PACING, memoryKv());
    await budget.setLimit(2);
    expect(await budget.consume(day1)).toBe(true);
    expect(await budget.consume(day1)).toBe(true);
    expect(await budget.consume(day1)).toBe(false);
    expect(await budget.consume(day2)).toBe(true);
  });

  test("persists the count, so a service worker restart cannot reset it", async () => {
    const kv = memoryKv();
    const a = new DailyBudget(RELEASE_PACING, kv);
    await a.setLimit(1);
    expect(await a.consume(day1)).toBe(true);
    const b = new DailyBudget(RELEASE_PACING, kv);
    expect(await b.consume(day1)).toBe(false);
  });

  test("a user may lower the budget but never raise it above the maximum", async () => {
    const budget = new DailyBudget(RELEASE_PACING, memoryKv());
    expect(await budget.setLimit(10 ** 9)).toBe(RELEASE_PACING.maxDailyPageBudget);
    expect(await budget.setLimit(0)).toBe(1);
  });
});
