import type Database from "better-sqlite3";
import { types } from "node:util";

export const JOB_STATES = [
  "queued",
  "running",
  "paused",
  "auth_required",
  "rate_limited",
  "partial",
  "failed",
  "complete",
  "cancelled",
] as const;
export type JobState = (typeof JOB_STATES)[number];

/** Allowed state transitions (CAP-04). Terminal states have no outgoing edges. */
export const TRANSITIONS: Readonly<Record<JobState, readonly JobState[]>> = {
  queued: ["running", "cancelled"],
  running: [
    "paused",
    "auth_required",
    "rate_limited",
    "partial",
    "failed",
    "complete",
    "cancelled",
    "queued",
  ],
  paused: ["queued", "cancelled"],
  auth_required: ["queued", "failed", "cancelled"],
  rate_limited: ["queued", "failed", "cancelled"],
  partial: ["queued", "cancelled"],
  failed: ["queued", "cancelled"],
  complete: [],
  cancelled: [],
};

export const TERMINAL_STATES: readonly JobState[] = ["complete", "cancelled"];

export class InvalidTransitionError extends Error {}
export class LeaseError extends Error {}
export class UnknownJobError extends Error {}

export interface Lease {
  owner: string;
  generation: number;
}

export interface Job {
  id: string;
  kind: string;
  state: JobState;
  accountId: string | null;
  collectionId: string | null;
  cursor: string | null;
  leaseOwner: string | null;
  leaseGeneration: number;
  leaseExpiresAt: number | null;
  retryCount: number;
  progress: string | null;
  stopReason: string | null;
  cancelRequested: boolean;
  checkpoint: string | null;
}

interface Row {
  id: string;
  kind: string;
  state: JobState;
  account_id: string | null;
  collection_id: string | null;
  cursor: string | null;
  lease_owner: string | null;
  lease_generation: number;
  lease_expires_at: number | null;
  retry_count: number;
  progress: string | null;
  stop_reason: string | null;
  cancel_requested: number;
  checkpoint: string | null;
}

const toJob = (r: Row): Job => ({
  id: r.id,
  kind: r.kind,
  state: r.state,
  accountId: r.account_id,
  collectionId: r.collection_id,
  cursor: r.cursor,
  leaseOwner: r.lease_owner,
  leaseGeneration: r.lease_generation,
  leaseExpiresAt: r.lease_expires_at,
  retryCount: r.retry_count,
  progress: r.progress,
  stopReason: r.stop_reason,
  cancelRequested: r.cancel_requested === 1,
  checkpoint: r.checkpoint,
});

export interface NewJob {
  id: string;
  kind: string;
  accountId?: string;
  collectionId?: string;
}

export interface CheckpointData {
  cursor?: string | null;
  checkpoint?: string | null;
  progress?: string | null;
}

/**
 * A callback result that is not a Promise or thenable (any callable `then`). Async callbacks fail to
 * type-check against it; `withLease` also refuses them at run time for untyped callers.
 */
export type SyncResult<T> = T extends { then(...args: never[]): unknown } ? never : T;

const ASYNC_WORK = "withLease work must be synchronous and cannot return a promise";

/**
 * Throws a TypeError (rolling back the enclosing transaction) if `result` is a Promise or thenable.
 * Never calls `then`: a native Promise (any realm) is only marked handled so its rejection cannot
 * surface as an unhandled rejection; a custom thenable's `then` is read once.
 */
function refuseAsyncResult<T>(result: T): T {
  if (types.isPromise(result)) {
    try {
      Promise.prototype.then.call(result, undefined, () => undefined);
    } catch {
      // A hostile Promise subclass species constructor; nothing else to suppress.
    }
    throw new TypeError(`${ASYNC_WORK}; it returned a Promise`);
  }
  if ((typeof result !== "object" && typeof result !== "function") || result === null) {
    return result;
  }
  let then: unknown;
  try {
    then = (result as { then?: unknown }).then;
  } catch (cause) {
    throw new TypeError(`${ASYNC_WORK}; reading \`then\` on its result failed`, { cause });
  }
  if (typeof then === "function") throw new TypeError(`${ASYNC_WORK}; it returned a thenable`);
  return result;
}

/** Time is epoch ms: a non-negative safe integer. Invalid values throw before any read or write. */
function checkTime(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError(`time must be a non-negative safe integer (ms), got ${nowMs}`);
  }
}

/** TTL is a positive safe integer and the resulting expiry must also be a safe integer. */
function checkExpiry(nowMs: number, ttlMs: number): number {
  checkTime(nowMs);
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new RangeError(`TTL must be a positive safe integer (ms), got ${ttlMs}`);
  }
  const expiresAt = nowMs + ttlMs;
  if (!Number.isSafeInteger(expiresAt)) {
    throw new RangeError(`lease expiry ${nowMs} + ${ttlMs} exceeds the safe integer range`);
  }
  return expiresAt;
}

/**
 * Job state machine, leases, and durable checkpoints (CAP-03, CAP-04, CAP-06). Time is injected as
 * epoch ms; every timed method throws RangeError for invalid time or TTL before changing anything.
 */
export class JobStore {
  private readonly db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  create(job: NewJob): Job {
    this.db
      .prepare(
        "INSERT INTO job (id, kind, state, account_id, collection_id) VALUES (?, ?, 'queued', ?, ?)",
      )
      .run(job.id, job.kind, job.accountId ?? null, job.collectionId ?? null);
    return this.get(job.id);
  }

  get(id: string): Job {
    const row = this.db.prepare("SELECT * FROM job WHERE id = ?").get(id) as Row | undefined;
    if (!row) throw new UnknownJobError(`unknown job ${id}`);
    return toJob(row);
  }

  /**
   * Acquire the lease for a queued job, or take over a running job whose lease expired.
   * Rejects while any other job holds a live lease for the same account and collection.
   * Returns the acquisition's Lease atomically, or null if excluded. Retain that token for
   * this attempt; never refresh a stale attempt's generation from get(id).
   */
  acquire(id: string, owner: string, nowMs: number, ttlMs: number): Lease | null {
    const expiresAt = checkExpiry(nowMs, ttlMs);
    return this.db
      .transaction(() => {
        const job = this.get(id);
        const reclaim =
          job.state === "running" && job.leaseExpiresAt !== null && job.leaseExpiresAt <= nowMs;
        if (job.state !== "queued" && !reclaim) return null;
        if (job.cancelRequested) {
          this.write(id, "cancelled", "cancelled by user");
          return null;
        }
        if (job.accountId !== null && job.collectionId !== null) {
          const conflict = this.db
            .prepare(
              `SELECT 1 FROM job WHERE id <> ? AND account_id = ? AND collection_id = ?
               AND lease_owner IS NOT NULL AND lease_expires_at > ?`,
            )
            .get(id, job.accountId, job.collectionId, nowMs);
          if (conflict) return null;
        }
        this.db
          .prepare(
            "UPDATE job SET state = 'running', lease_owner = ?, lease_expires_at = ?, lease_generation = lease_generation + 1, stop_reason = NULL WHERE id = ?",
          )
          .run(owner, expiresAt, id);
        return { owner, generation: this.get(id).leaseGeneration };
      })
      .immediate();
  }

  /** Extend a live lease. Throws if the lease is not held or has expired. */
  renew(id: string, owner: Lease, nowMs: number, ttlMs: number): void {
    const expiresAt = checkExpiry(nowMs, ttlMs);
    this.db
      .transaction(() => {
        this.assertLease(id, owner, nowMs);
        this.db.prepare("UPDATE job SET lease_expires_at = ? WHERE id = ?").run(expiresAt, id);
      })
      .immediate();
  }

  /**
   * Run `fn` atomically under the retained `lease`. Validation and `fn` share one IMMEDIATE
   * transaction (a savepoint when already inside one), so the lease cannot expire, be taken over or
   * change generation between the check and the work: `fn` sees exactly the validated job. Throws
   * RangeError for an invalid clock and LeaseError for a stale owner, generation or expired lease
   * before `fn` runs. A throw from `fn` rolls back everything it wrote.
   *
   * `fn` must be synchronous and trusted: only the writes it makes before returning are fenced.
   * - An async function (including an async generator, from any realm) is refused with a TypeError
   *   before it is invoked, so none of its code runs.
   * - Async work the check cannot recognize (for example a bound or proxied async function, or a
   *   plain function returning a Promise or thenable) has already run up to its first `await`;
   *   withLease rolls back those writes and throws a TypeError. A rejected native Promise is marked
   *   handled; a custom thenable's `then` is read once but never called.
   * - withLease cannot stop work that `fn` schedules to run later (continuations after `await`,
   *   timers, callbacks). Such work runs outside the transaction and unfenced by the lease, so a
   *   callback must not schedule database writes.
   */
  withLease<T>(id: string, lease: Lease, nowMs: number, fn: (job: Job) => SyncResult<T>): T {
    checkTime(nowMs);
    if (types.isAsyncFunction(fn)) throw new TypeError(`${ASYNC_WORK}; got an async function`);
    return this.db
      .transaction(() => refuseAsyncResult(fn(this.assertLease(id, lease, nowMs)) as T))
      .immediate();
  }

  /** Persist cursor/checkpoint/progress durably; fenced by the live lease. Returns whether cancel was requested. */
  checkpoint(id: string, owner: Lease, nowMs: number, data: CheckpointData): boolean {
    checkTime(nowMs);
    return this.db
      .transaction(() => {
        const job = this.assertLease(id, owner, nowMs);
        this.db
          .prepare("UPDATE job SET cursor = ?, checkpoint = ?, progress = ? WHERE id = ?")
          .run(
            data.cursor === undefined ? job.cursor : data.cursor,
            data.checkpoint === undefined ? job.checkpoint : data.checkpoint,
            data.progress === undefined ? job.progress : data.progress,
            id,
          );
        return job.cancelRequested;
      })
      .immediate();
  }

  /** Owner moves a running job out of `running`; releases the lease. */
  transition(id: string, owner: Lease, nowMs: number, to: JobState, stopReason?: string): void {
    checkTime(nowMs);
    this.db
      .transaction(() => {
        const job = this.assertLease(id, owner, nowMs);
        this.assertEdge(job.state, to);
        if (to === "running") throw new InvalidTransitionError("use acquire to start a job");
        this.write(
          id,
          job.cancelRequested ? "cancelled" : to,
          job.cancelRequested ? "cancelled by user" : (stopReason ?? null),
        );
      })
      .immediate();
  }

  /** User or system moves a non-running job (resume, retry). Resuming queues the job again. */
  resume(id: string): void {
    this.db
      .transaction(() => {
        const job = this.get(id);
        if (job.state === "running") {
          throw new InvalidTransitionError("use the live lease to requeue a running job");
        }
        this.assertEdge(job.state, "queued");
        if (job.state === "failed") {
          this.db.prepare("UPDATE job SET retry_count = retry_count + 1 WHERE id = ?").run(id);
        }
        this.write(id, "queued", null);
      })
      .immediate();
  }

  /**
   * Cancel stops new work and keeps committed records (CAP-04). A job under a live lease records the
   * request and the owner finishes with `transition(..., "cancelled")`; otherwise it cancels at once.
   */
  cancel(id: string, nowMs: number): Job {
    checkTime(nowMs);
    this.db
      .transaction(() => {
        const job = this.get(id);
        this.assertEdge(job.state, "cancelled");
        const live =
          job.state === "running" && job.leaseExpiresAt !== null && job.leaseExpiresAt > nowMs;
        if (live) {
          this.db.prepare("UPDATE job SET cancel_requested = 1 WHERE id = ?").run(id);
        } else {
          this.write(id, "cancelled", "cancelled by user");
        }
      })
      .immediate();
    return this.get(id);
  }

  /** Jobs left `running` with an expired lease after a crash; they are reclaimed with `acquire`. */
  findExpired(nowMs: number): Job[] {
    checkTime(nowMs);
    return (
      this.db
        .prepare("SELECT * FROM job WHERE state = 'running' AND lease_expires_at <= ?")
        .all(nowMs) as Row[]
    ).map(toJob);
  }

  private write(id: string, state: JobState, stopReason: string | null): void {
    this.db
      .prepare(
        "UPDATE job SET state = ?, stop_reason = ?, lease_owner = NULL, lease_expires_at = NULL, cancel_requested = 0 WHERE id = ?",
      )
      .run(state, stopReason, id);
  }

  private assertEdge(from: JobState, to: JobState): void {
    if (!TRANSITIONS[from].includes(to)) {
      throw new InvalidTransitionError(`invalid transition ${from} -> ${to}`);
    }
  }

  private assertLease(id: string, owner: Lease, nowMs: number): Job {
    const job = this.get(id);
    if (
      job.state !== "running" ||
      job.leaseOwner !== owner?.owner ||
      job.leaseGeneration !== owner?.generation ||
      job.leaseExpiresAt === null ||
      job.leaseExpiresAt <= nowMs
    ) {
      throw new LeaseError(
        `lease ${String(owner?.owner)}#${String(owner?.generation)} is not the live lease on ${id}`,
      );
    }
    return job;
  }
}
