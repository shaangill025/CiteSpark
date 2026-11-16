import type Database from "better-sqlite3";

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

/** Job state machine, leases, and durable checkpoints (CAP-03, CAP-04, CAP-06). Time is injected as epoch ms. */
export class JobStore {
  constructor(private readonly db: Database.Database) {}

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
          .run(owner, nowMs + ttlMs, id);
        return { owner, generation: this.get(id).leaseGeneration };
      })
      .immediate();
  }

  /** Extend a live lease. Throws if the lease is not held or has expired. */
  renew(id: string, owner: Lease, nowMs: number, ttlMs: number): void {
    this.db
      .transaction(() => {
        this.assertLease(id, owner, nowMs);
        this.db.prepare("UPDATE job SET lease_expires_at = ? WHERE id = ?").run(nowMs + ttlMs, id);
      })
      .immediate();
  }

  /** Persist cursor/checkpoint/progress durably; fenced by the live lease. Returns whether cancel was requested. */
  checkpoint(id: string, owner: Lease, nowMs: number, data: CheckpointData): boolean {
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
      job.leaseOwner !== owner.owner ||
      job.leaseGeneration !== owner.generation ||
      job.leaseExpiresAt === null ||
      job.leaseExpiresAt <= nowMs
    ) {
      throw new LeaseError(`${owner} does not hold a live lease on ${id}`);
    }
    return job;
  }
}
