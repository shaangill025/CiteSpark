import { RequestError } from "@citspark/ipc";
import { collectionKey, toCaptureRecords, xAdapter, type CollectionRef } from "@citspark/capture-x";
import {
  CapturePagePayloadSchema,
  type CapturePagePayload,
  type CapturePageResult,
  type CaptureRenewPayload,
  type CaptureStartPayload,
  type CaptureStartResult,
  type CaptureStopPayload,
  type CaptureStopReason,
} from "@citspark/protocol";
import {
  backoffDelay,
  nextScrollDelay,
  parseRetryAfter,
  type DailyBudget,
  type PacerConfig,
} from "./pacer.ts";

/** What the page observer reports for one of X's own recognized responses. Never headers or cookies. */
export type Observation =
  | {
      kind: "page";
      collection: string;
      cursor: string | null;
      status: number;
      retryAfter: string | null;
      body: string | null;
      tooLarge: boolean;
    }
  | { kind: "viewer" | "folders"; status: number; body: string | null; tooLarge: boolean };

export interface DesktopApi {
  start(p: CaptureStartPayload): Promise<CaptureStartResult>;
  /** `requestId` is stable per pass and page, so a retry after reconnect replays the stored outcome. */
  page(p: CapturePagePayload, requestId: string): Promise<CapturePageResult>;
  /** Lease heartbeat for the exact pass; extends the desktop lease and carries no data. */
  renew(p: CaptureRenewPayload): Promise<unknown>;
  stop(p: CaptureStopPayload): Promise<unknown>;
}

export interface TabApi {
  /** Scroll to the bottom so X itself requests the next page. */
  scroll(): void;
  /** Open the collection from the top (a fresh pass, ADR 0005). */
  load?(): void;
}

export type RunState =
  | "starting"
  | "capturing"
  | "catching_up"
  | "backing_off"
  | "complete"
  | "partial"
  | "paused"
  | "cancelled"
  | "auth_required"
  | "rate_limited"
  | "failed"
  | "desktop_unavailable";

export const TERMINAL: ReadonlySet<RunState> = new Set([
  "complete",
  "partial",
  "paused",
  "cancelled",
  "auth_required",
  "rate_limited",
  "failed",
  "desktop_unavailable",
]);

export interface RunStatus {
  state: RunState;
  reason?: string;
  jobId?: string;
  collection: string;
  pages: number;
  newRecords: number;
  retryAt?: number;
}

type Outcome = CaptureStopPayload["outcome"];

export interface RunOptions {
  collection: CollectionRef;
  accountId: string;
  desktop: DesktopApi;
  tab: TabApi;
  timers: { set(fn: () => void, ms: number): unknown; clear(id: unknown): void };
  now: () => number;
  random: () => number;
  pacing: PacerConfig;
  budget: DailyBudget;
  onUpdate?: (s: RunStatus) => void;
}

/**
 * One capture pass driven by passive observation and scrolling (ADR 0005). The cursor advances only
 * after the desktop acknowledged the page commit (CAP-03). Every unclear end (auth, 429, schema
 * change, disk full, cursor loop, no progress, lost desktop) stops as something other than complete
 * (T02); only the desktop's acknowledgment of an end page completes a run.
 */
export class CaptureRun {
  readonly #o: RunOptions;
  readonly #key: string;
  #status: RunStatus;
  #jobId = "";
  #passId = "";
  #seq = 0;
  #expected: string | null = null;
  #catchingUp = false;
  #rateLimited = 0;
  #transient = 0;
  #noProgress = 0;
  #timer: unknown;
  #beat: unknown;
  #chain: Promise<void> = Promise.resolve();
  /** Observations queued or being committed; no scroll happens while one is unacknowledged. */
  #pending = 0;

  constructor(o: RunOptions) {
    this.#o = o;
    this.#key = collectionKey(o.collection);
    this.#status = { state: "starting", collection: this.#key, pages: 0, newRecords: 0 };
  }

  get status(): RunStatus {
    return { ...this.#status };
  }

  get terminal(): boolean {
    return TERMINAL.has(this.#status.state);
  }

  async begin(): Promise<RunStatus> {
    if (!(await this.#o.budget.consume(this.#o.now()))) {
      this.#set({ state: "paused", reason: "daily_budget" });
      return this.status;
    }
    let started: CaptureStartResult;
    try {
      started = await this.#o.desktop.start({
        accountId: this.#o.accountId,
        collection: this.#key,
        adapter: { id: xAdapter.id, version: xAdapter.version },
      });
    } catch (e) {
      this.#set(this.#desktopFailure(e));
      return this.status;
    }
    this.#jobId = started.jobId;
    this.#passId = started.passId;
    this.#catchingUp = started.resumed;
    this.#set({ state: started.resumed ? "catching_up" : "capturing", jobId: started.jobId });
    this.#o.tab.load?.();
    this.#armNoProgress();
    this.#scheduleBeat();
    return this.status;
  }

  observe(obs: Observation): Promise<void> {
    this.#pending++;
    this.#chain = this.#chain
      .then(() => this.#handle(obs))
      .catch(() => undefined)
      .finally(() => void this.#pending--);
    return this.#chain;
  }

  pause(): Promise<void> {
    return this.#stop("paused", "user_pause");
  }

  cancel(): Promise<void> {
    return this.#stop("cancelled", "user_cancel");
  }

  tabClosed(): Promise<void> {
    return this.#stop("paused", "tab_closed");
  }

  async #handle(obs: Observation): Promise<void> {
    if (this.terminal || this.#jobId === "") return;
    if (obs.kind === "viewer") return this.#viewer(obs);
    if (obs.kind !== "page") return;
    if (obs.collection !== this.#key || obs.cursor !== this.#expected) return;
    this.#clearTimer();
    this.#noProgress = 0;
    if (obs.status === 401 || obs.status === 403)
      return this.#stop("auth_required", "auth_required");
    if (obs.status === 429) return this.#rateLimit(obs.retryAfter);
    if (obs.status === 0 || obs.status >= 500) return this.#transientError(obs.retryAfter);
    if (obs.status < 200 || obs.status > 299) return this.#stop("paused", "unsupported_schema");
    this.#rateLimited = 0;
    this.#transient = 0;
    if (obs.tooLarge) return this.#stop("paused", "response_too_large");
    let body: unknown;
    try {
      body = JSON.parse(obs.body ?? "");
    } catch {
      return this.#stop("paused", "unsupported_schema");
    }
    const parsed = xAdapter.parsePage(body, this.#o.collection);
    if (parsed.status === "paused") {
      if (parsed.reason === "control_only") return this.#armNoProgress();
      return this.#stop("paused", "unsupported_schema");
    }
    const mapped = toCaptureRecords(parsed.page);
    const payload = CapturePagePayloadSchema.safeParse({
      jobId: this.#jobId,
      passId: this.#passId,
      accountId: this.#o.accountId,
      collection: this.#key,
      cursorIn: this.#expected,
      cursorOut: mapped.cursorOut,
      adapter: { id: xAdapter.id, version: parsed.page.adapterVersion },
      records: mapped.records,
      gaps: mapped.gaps,
    });
    if (!payload.success) return this.#stop("paused", "unsupported_schema");
    let ack: CapturePageResult;
    try {
      ack = await this.#o.desktop.page(payload.data, `${this.#passId}:${this.#seq}`);
    } catch (e) {
      return this.#pageFailure(e);
    }
    this.#seq++;
    if (ack.newRecords > 0) this.#catchingUp = false;
    const pages = this.#status.pages + 1;
    const newRecords = this.#status.newRecords + ack.newRecords;
    if (ack.outcome !== "continue") {
      this.#set({ state: ack.outcome, pages, newRecords });
      return;
    }
    if (this.terminal) return; // paused or cancelled while the commit was in flight
    this.#expected = mapped.cursorOut;
    this.#set({ state: this.#catchingUp ? "catching_up" : "capturing", pages, newRecords });
    this.#schedule(nextScrollDelay(this.#o.pacing, this.#o.random));
  }

  async #viewer(obs: Extract<Observation, { kind: "viewer" | "folders" }>): Promise<void> {
    if (obs.status === 401 || obs.status === 403)
      return this.#stop("auth_required", "auth_required");
    if (obs.status !== 200 || obs.tooLarge || obs.body === null) return;
    let account: string | undefined;
    try {
      account = xAdapter.detectAccount(JSON.parse(obs.body))?.accountId;
    } catch {
      return;
    }
    if (account !== undefined && account !== this.#o.accountId) {
      return this.#stop("paused", "account_mismatch");
    }
  }

  #rateLimit(retryAfter: string | null): Promise<void> | void {
    const wait = parseRetryAfter(retryAfter, this.#o.now());
    const retryAfterSec = wait === null ? undefined : Math.ceil(wait / 1000);
    this.#rateLimited++;
    if (
      this.#rateLimited > this.#o.pacing.maxRateLimitRetries ||
      (wait !== null && wait > this.#o.pacing.maxRetryAfterHoldMs)
    ) {
      return this.#stop("rate_limited", "rate_limited", retryAfterSec);
    }
    this.#backoff(backoffDelay(this.#o.pacing, this.#rateLimited - 1, this.#o.random, wait));
  }

  #transientError(retryAfter: string | null): Promise<void> | void {
    this.#transient++;
    if (this.#transient > this.#o.pacing.maxTransientRetries) {
      return this.#stop("failed", "transient_errors");
    }
    const wait = parseRetryAfter(retryAfter, this.#o.now());
    this.#backoff(backoffDelay(this.#o.pacing, this.#transient - 1, this.#o.random, wait));
  }

  #backoff(ms: number): void {
    this.#set({ state: "backing_off", retryAt: this.#o.now() + ms });
    this.#schedule(ms);
  }

  #pageFailure(e: unknown): Promise<void> | void {
    if (!(e instanceof RequestError)) {
      this.#set({ state: "desktop_unavailable", reason: "desktop_unavailable" });
      return;
    }
    const code = e.error.code;
    // The desktop already moved the job out of running for these; nothing else to tell it.
    if (code === "disk_full" || code === "account_mismatch") {
      return this.#set({ state: "paused", reason: code });
    }
    if (code === "cursor_loop" || code === "lease_lost" || code === "checkpoint_corrupt") {
      return this.#set({ state: "failed", reason: code });
    }
    if (code === "cursor_mismatch") return this.#stop("paused", "no_progress");
    return this.#stop("failed", "transient_errors");
  }

  #desktopFailure(e: unknown): Partial<RunStatus> {
    if (e instanceof RequestError) return { state: "failed", reason: e.error.code };
    return { state: "desktop_unavailable", reason: "desktop_unavailable" };
  }

  #schedule(ms: number): void {
    this.#clearTimer();
    this.#timer = this.#o.timers.set(() => {
      this.#timer = undefined;
      void this.#scroll();
    }, ms);
  }

  async #scroll(): Promise<void> {
    // A page is still being committed: its acknowledgment schedules the next scroll (CAP-03).
    if (this.terminal) return;
    if (this.#pending > 0) return this.#schedule(this.#o.pacing.minDelayMs);
    if (!(await this.#o.budget.consume(this.#o.now()))) return this.#stop("paused", "daily_budget");
    if (this.terminal) return;
    if (this.#status.state === "backing_off") {
      this.#set({ state: this.#catchingUp ? "catching_up" : "capturing" });
    }
    this.#o.tab.scroll();
    this.#armNoProgress();
  }

  #armNoProgress(): void {
    this.#clearTimer();
    this.#timer = this.#o.timers.set(() => {
      this.#timer = undefined;
      if (this.terminal) return;
      if (this.#pending > 0) return this.#armNoProgress();
      this.#noProgress++;
      if (this.#noProgress > this.#o.pacing.maxNoProgressScrolls) {
        void this.#stop("paused", "no_progress");
      } else {
        void this.#scroll();
      }
    }, this.#o.pacing.noProgressMs);
  }

  /**
   * Keeps the desktop lease alive through pacing holds and long scrolls (D1). Only lease_lost ends
   * the run; a temporary outage is retried on the next beat and a page commit still proves liveness.
   */
  #scheduleBeat(): void {
    if (this.#beat !== undefined) this.#o.timers.clear(this.#beat);
    this.#beat = this.#o.timers.set(() => {
      this.#beat = undefined;
      void this.#heartbeat();
    }, this.#o.pacing.leaseHeartbeatMs);
  }

  async #heartbeat(): Promise<void> {
    if (this.terminal || this.#jobId === "") return;
    try {
      await this.#o.desktop.renew({ jobId: this.#jobId, passId: this.#passId });
    } catch (e) {
      if (e instanceof RequestError && e.error.code === "lease_lost" && !this.terminal) {
        this.#clearTimer();
        this.#set({ state: "failed", reason: "lease_lost" });
        return;
      }
    }
    if (!this.terminal) this.#scheduleBeat();
  }

  #clearBeat(): void {
    if (this.#beat !== undefined) this.#o.timers.clear(this.#beat);
    this.#beat = undefined;
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) this.#o.timers.clear(this.#timer);
    this.#timer = undefined;
  }

  async #stop(outcome: Outcome, reason: CaptureStopReason, retryAfterSec?: number): Promise<void> {
    if (this.terminal) return;
    this.#clearTimer();
    const retryAt = retryAfterSec === undefined ? undefined : this.#o.now() + retryAfterSec * 1000;
    this.#set({ state: outcome, reason, ...(retryAt === undefined ? {} : { retryAt }) });
    if (this.#jobId === "") return;
    try {
      await this.#o.desktop.stop({
        jobId: this.#jobId,
        passId: this.#passId,
        outcome,
        reason,
        ...(retryAfterSec === undefined ? {} : { retryAfterSec }),
      });
    } catch {
      // The desktop is gone; its lease expires and the job is never complete.
    }
  }

  #set(patch: Partial<RunStatus>): void {
    const next: RunStatus = { ...this.#status, ...patch };
    if (!("retryAt" in patch) && patch.state !== undefined && patch.state !== "backing_off") {
      delete next.retryAt;
    }
    if (patch.state !== undefined && !TERMINAL.has(patch.state) && !("reason" in patch)) {
      delete next.reason;
    }
    this.#status = next;
    if (TERMINAL.has(next.state)) this.#clearBeat();
    this.#o.onUpdate?.(this.status);
  }
}
