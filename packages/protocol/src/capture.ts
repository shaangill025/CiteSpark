import { z } from "zod";

/**
 * Capture methods between the extension and the desktop core (ADR 0005, M1-08). All need the
 * `capture.write` scope and are mutations, so retries after a reconnect hit the idempotency ledger.
 * Pages carry parsed records only: never a raw response, cookie, header, or token (SEC-04).
 */
export const CaptureMethod = {
  start: "capture.start",
  page: "capture.page",
  stop: "capture.stop",
  /** Lease heartbeat while the extension waits (pacing holds, long scrolls); extends the lease only. */
  renew: "capture.renew",
} as const;

/** Records per page; X pages hold about 20 entries, so this only bounds a hostile or broken page. */
export const CAPTURE_MAX_RECORDS = 500;
const MAX_TEXT = 100_000;

/** X platform IDs: decimal strings, never numbers (CAP-02). */
export const PlatformIdSchema = z.string().regex(/^[0-9]{1,25}$/);
const Opaque = (max: number) => z.string().min(1).max(max);

/** `bookmarks`, `likes` or `bookmark_folder:<id>`; also the store's collection ID. */
export const CollectionKeySchema = z
  .string()
  .regex(/^(bookmarks|likes|bookmark_folder:[0-9]{1,25})$/);
export type CollectionKey = z.infer<typeof CollectionKeySchema>;

const AdapterSchema = z.strictObject({ id: Opaque(64), version: Opaque(32) });
const JobIdSchema = Opaque(128);
const CursorSchema = z.string().min(1).max(4096);

export const CaptureRecordWireSchema = z.strictObject({
  sourceType: z.literal("x_post"),
  platformId: PlatformIdSchema,
  text: z.string().max(MAX_TEXT),
  authorId: PlatformIdSchema.nullable(),
  authorHandle: z
    .string()
    .regex(/^[A-Za-z0-9_]{1,64}$/)
    .nullable(),
  canonicalUrl: z
    .string()
    .max(512)
    .regex(/^https:\/\/x\.com\/[A-Za-z0-9_]{1,64}\/status\/[0-9]{1,25}$/)
    .nullable(),
  publishedAt: z.iso.datetime().nullable(),
});
export type CaptureRecordWire = z.infer<typeof CaptureRecordWireSchema>;

export const CaptureStartPayloadSchema = z.strictObject({
  accountId: PlatformIdSchema,
  collection: CollectionKeySchema,
  adapter: AdapterSchema,
});
export type CaptureStartPayload = z.infer<typeof CaptureStartPayloadSchema>;

export const CaptureStartResultSchema = z.strictObject({
  jobId: JobIdSchema,
  passId: Opaque(128),
  /** The job already holds committed pages: this pass re-reads them first ("catching up", ADR 0005). */
  resumed: z.boolean(),
  committedPages: z.int().min(0),
});
export type CaptureStartResult = z.infer<typeof CaptureStartResultSchema>;

export const CapturePagePayloadSchema = z.strictObject({
  jobId: JobIdSchema,
  passId: Opaque(128),
  accountId: PlatformIdSchema,
  collection: CollectionKeySchema,
  cursorIn: CursorSchema.nullable(),
  /** `null` only when the adapter recognized the end of the collection (CAP-06). */
  cursorOut: CursorSchema.nullable(),
  adapter: AdapterSchema,
  records: z.array(CaptureRecordWireSchema).max(CAPTURE_MAX_RECORDS),
  /** Gaps the adapter saw on this page; any gap in a pass ends it as `partial`, never `complete`. */
  gaps: z.strictObject({
    unavailable: z.int().min(0).max(CAPTURE_MAX_RECORDS),
    partialThreads: z.int().min(0).max(CAPTURE_MAX_RECORDS),
  }),
});
export type CapturePagePayload = z.infer<typeof CapturePagePayloadSchema>;

export const CapturePageResultSchema = z.strictObject({
  status: z.enum(["committed", "replayed"]),
  seq: z.int().min(0),
  /** `continue` until a committed end page; `partial` when the pass ended with gaps (T02). */
  outcome: z.enum(["continue", "complete", "partial"]),
  newRecords: z.int().min(0),
});
export type CapturePageResult = z.infer<typeof CapturePageResultSchema>;

export const CaptureStopReasonSchema = z.enum([
  "user_pause",
  "user_cancel",
  "auth_required",
  "rate_limited",
  "daily_budget",
  "unsupported_schema",
  "control_only",
  "cursor_loop",
  "account_mismatch",
  "account_unknown",
  "tab_closed",
  "no_progress",
  "response_too_large",
  "transient_errors",
  "disk_full",
]);
export type CaptureStopReason = z.infer<typeof CaptureStopReasonSchema>;

/** A client can stop a job but never declare it complete (T02). */
export const CaptureStopPayloadSchema = z.strictObject({
  jobId: JobIdSchema,
  /** The exact pass this stop ends: a delayed stop from a replaced pass cannot end its successor. */
  passId: Opaque(128),
  outcome: z.enum(["paused", "cancelled", "auth_required", "rate_limited", "failed"]),
  reason: CaptureStopReasonSchema,
  retryAfterSec: z.int().min(0).max(86_400).optional(),
});
export type CaptureStopPayload = z.infer<typeof CaptureStopPayloadSchema>;

export const CaptureStopResultSchema = z.strictObject({ state: Opaque(32) });

/** Heartbeat for the exact pass that holds the lease; it carries no capture data. */
export const CaptureRenewPayloadSchema = z.strictObject({
  jobId: JobIdSchema,
  passId: Opaque(128),
});
export type CaptureRenewPayload = z.infer<typeof CaptureRenewPayloadSchema>;

export const CaptureRenewResultSchema = z.strictObject({ renewed: z.literal(true) });
export type CaptureRenewResult = z.infer<typeof CaptureRenewResultSchema>;
