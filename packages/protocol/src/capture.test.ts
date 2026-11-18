import { describe, expect, test } from "vitest";
import {
  CAPTURE_MAX_RECORDS,
  CaptureMethod,
  CapturePagePayloadSchema,
  CapturePageResultSchema,
  CaptureStartPayloadSchema,
  CaptureStopPayloadSchema,
  ErrorCode,
} from "./index.ts";

const record = {
  sourceType: "x_post",
  platformId: "1900000000000000101",
  text: "Synthetic text",
  authorId: "7000000000000000001",
  authorHandle: "synth_alice",
  canonicalUrl: "https://x.com/synth_alice/status/1900000000000000101",
  publishedAt: "2025-01-01T00:00:00.000Z",
};

const page = {
  jobId: "job-1",
  passId: "pass-1",
  accountId: "7000000000000000001",
  collection: "bookmarks",
  cursorIn: null,
  cursorOut: "SYNTHETIC_BOTTOM_CURSOR_1",
  adapter: { id: "x-web", version: "1.0.0" },
  records: [record],
  gaps: { unavailable: 0, partialThreads: 0 },
};

describe("capture wire contract (CAP-02, CAP-03, CAP-04)", () => {
  test("names the three capture methods", () => {
    expect(CaptureMethod).toEqual({
      start: "capture.start",
      page: "capture.page",
      stop: "capture.stop",
    });
  });

  test("accepts a parsed page bound to an account and collection", () => {
    expect(CapturePagePayloadSchema.safeParse(page).success).toBe(true);
    expect(
      CapturePagePayloadSchema.safeParse({
        ...page,
        collection: "bookmark_folder:1800000000000000001",
      }).success,
    ).toBe(true);
  });

  test("keeps platform IDs as digit strings and rejects numbers (CAP-02)", () => {
    expect(CapturePagePayloadSchema.safeParse({ ...page, accountId: 7000 }).success).toBe(false);
    expect(
      CapturePagePayloadSchema.safeParse({ ...page, records: [{ ...record, platformId: "19e17" }] })
        .success,
    ).toBe(false);
  });

  test("rejects unknown fields, so no cookie or header can ride along (SEC-04)", () => {
    expect(CapturePagePayloadSchema.safeParse({ ...page, cookie: "ct0=x" }).success).toBe(false);
    expect(
      CapturePagePayloadSchema.safeParse({ ...page, records: [{ ...record, authorization: "x" }] })
        .success,
    ).toBe(false);
  });

  test("bounds untrusted pages", () => {
    const many = Array.from({ length: CAPTURE_MAX_RECORDS + 1 }, () => record);
    expect(CapturePagePayloadSchema.safeParse({ ...page, records: many }).success).toBe(false);
    expect(
      CapturePagePayloadSchema.safeParse({ ...page, collection: "bookmark_folder:../../x" })
        .success,
    ).toBe(false);
    expect(
      CapturePagePayloadSchema.safeParse({
        ...page,
        records: [{ ...record, canonicalUrl: "javascript:alert(1)" }],
      }).success,
    ).toBe(false);
  });

  test("start names an account and a collection only", () => {
    expect(
      CaptureStartPayloadSchema.safeParse({
        accountId: "7000000000000000001",
        collection: "likes",
        adapter: { id: "x-web", version: "1.0.0" },
      }).success,
    ).toBe(true);
  });

  test("stop carries an honest non-complete outcome and reason", () => {
    expect(
      CaptureStopPayloadSchema.safeParse({
        jobId: "job-1",
        passId: "pass-1",
        outcome: "rate_limited",
        reason: "rate_limited",
        retryAfterSec: 60,
      }).success,
    ).toBe(true);
    // A client can never declare a job complete; only a committed end page does that.
    expect(
      CaptureStopPayloadSchema.safeParse({
        jobId: "job-1",
        passId: "pass-1",
        outcome: "complete",
        reason: "x",
      }).success,
    ).toBe(false);
    // A stop is bound to the exact pass it ends, so a delayed stop cannot end a newer pass.
    expect(
      CaptureStopPayloadSchema.safeParse({
        jobId: "job-1",
        outcome: "paused",
        reason: "user_pause",
      }).success,
    ).toBe(false);
  });

  test("page result distinguishes continue, complete and partial", () => {
    for (const outcome of ["continue", "complete", "partial"]) {
      expect(
        CapturePageResultSchema.safeParse({
          status: "committed",
          seq: 0,
          outcome,
          newRecords: 1,
        }).success,
      ).toBe(true);
    }
  });

  test("adds capture error codes", () => {
    expect(ErrorCode.DiskFull).toBe("disk_full");
    expect(ErrorCode.AccountMismatch).toBe("account_mismatch");
    expect(ErrorCode.CursorLoop).toBe("cursor_loop");
    expect(ErrorCode.CursorMismatch).toBe("cursor_mismatch");
    expect(ErrorCode.JobBusy).toBe("job_busy");
    expect(ErrorCode.LeaseLost).toBe("lease_lost");
  });
});
