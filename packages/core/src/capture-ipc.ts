import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  CaptureMethod,
  CapturePagePayloadSchema,
  type CapturePageResult,
  CaptureRenewPayloadSchema,
  type CaptureRenewResult,
  CaptureStartPayloadSchema,
  type CaptureStartResult,
  CaptureStopPayloadSchema,
  ErrorCode,
  ProtocolException,
  Scope,
} from "@citspark/protocol";
import {
  AccountMismatchError,
  CaptureStore,
  CheckpointCorruptError,
  CursorLoopError,
  CursorMismatchError,
  JobStore,
  LeaseError,
  ReplayConflictError,
  type Lease,
} from "@citspark/store";
import type { MethodHandler, RequestContext } from "./ipc/server.ts";

/** Job kind for live X capture through the extension. */
export const X_CAPTURE_KIND = "x-capture";
/** Store account IDs are namespaced by platform so more accounts and platforms fit later (Q22). */
export const xAccountKey = (accountId: string): string => `x:${accountId}`;

export interface CaptureHandlerOptions {
  db: Database.Database;
  now?: () => number;
  /** A page commit renews the lease; a client silent for this long loses the job. */
  leaseTtlMs?: number;
  newId?: () => string;
}

interface Held {
  lease: Lease;
  clientId: string;
  passId: string;
}

const invalid = (what: string) =>
  new ProtocolException(ErrorCode.InvalidMessage, `Invalid ${what} payload.`);

function isDiskFull(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code;
  return code === "SQLITE_FULL" || code === "ENOSPC";
}

/**
 * Desktop handlers for the extension's capture (ADR 0005, M1-08). The core is the authority: it binds
 * each job to an account and collection, owns the lease and the pass, commits each page atomically
 * with its cursor (CAP-03), and acknowledges only after the commit. A client can stop a job but can
 * never declare it complete; only a committed end page does that, and a pass with gaps ends partial.
 */
export function captureHandlers(opts: CaptureHandlerOptions): Record<string, MethodHandler> {
  const jobs = new JobStore(opts.db);
  const capture = new CaptureStore(opts.db, jobs);
  const now = opts.now ?? Date.now;
  const ttl = opts.leaseTtlMs ?? 120_000;
  const newId = opts.newId ?? randomUUID;
  const held = new Map<string, Held>();

  const leaseLive = (job: { leaseExpiresAt: number | null }): boolean =>
    job.leaseExpiresAt !== null && job.leaseExpiresAt > now();

  const holder = (jobId: string, ctx: RequestContext): Held => {
    const h = held.get(jobId);
    if (!h || h.clientId !== ctx.client.id) {
      throw new ProtocolException(
        ErrorCode.LeaseLost,
        "This capture is no longer active here. Start it again.",
      );
    }
    return h;
  };

  /** True while the job is still the same running acquisition, only its lease has run out. */
  const stillOurs = (jobId: string, lease: Lease): boolean => {
    const j = jobs.get(jobId);
    return (
      j.state === "running" &&
      j.leaseOwner === lease.owner &&
      j.leaseGeneration === lease.generation &&
      !leaseLive(j)
    );
  };

  /** Moves a job out of running and forgets its lease; never throws past a failed write. */
  const settle = (jobId: string, h: Held, to: "paused" | "failed", reason: string) => {
    held.delete(jobId);
    try {
      jobs.transition(jobId, h.lease, now(), to, reason);
    } catch {
      // Lease already gone or the disk is still full: the lease expires and the job is never complete.
    }
  };

  const start: MethodHandler = {
    scope: Scope.CaptureWrite,
    mutation: true,
    async handle(payload, ctx): Promise<CaptureStartResult> {
      const p = CaptureStartPayloadSchema.safeParse(payload);
      if (!p.success) throw invalid("capture.start");
      const account = xAccountKey(p.data.accountId);
      const collection = p.data.collection;
      let job = jobs.findOpen(X_CAPTURE_KIND, account, collection);
      if (job === null) {
        job = jobs.create({
          id: `capture-${newId()}`,
          kind: X_CAPTURE_KIND,
          accountId: account,
          collectionId: collection,
        });
      }
      if (job.state === "running" && job.cancelRequested && !leaseLive(job)) {
        // A cancel was requested in Citspark and the holder went silent: finish it, never resume it.
        held.delete(job.id);
        jobs.acquire(job.id, `extension:${ctx.client.id}`, now(), ttl); // writes cancelled, returns null
        job = jobs.create({
          id: `capture-${newId()}`,
          kind: X_CAPTURE_KIND,
          accountId: account,
          collectionId: collection,
        });
      }
      const mine = held.get(job.id);
      if (job.state === "running" && mine?.clientId === ctx.client.id) {
        // The same client restarted (service worker restart, new tab): fence its older pass.
        held.delete(job.id);
        try {
          jobs.transition(job.id, mine.lease, now(), "queued", "restarted by the same client");
        } catch (e) {
          // The old lease expired (or another client took the job): acquire below reclaims an
          // expired job cleanly and answers job_busy for a live successor. Never a raw LeaseError.
          if (!(e instanceof LeaseError)) throw e;
        }
      } else if (job.state !== "running" && job.state !== "queued") {
        jobs.resume(job.id);
      }
      const lease = jobs.acquire(job.id, `extension:${ctx.client.id}`, now(), ttl);
      if (lease === null) {
        throw new ProtocolException(
          ErrorCode.JobBusy,
          "Another capture of this collection is running. Try again in a few minutes.",
        );
      }
      const passId = `pass-${newId()}`;
      held.set(job.id, { lease, clientId: ctx.client.id, passId });
      const committedPages = capture.summary(job.id).pages;
      return { jobId: job.id, passId, resumed: committedPages > 0, committedPages };
    },
  };

  const page: MethodHandler = {
    scope: Scope.CaptureWrite,
    mutation: true,
    async handle(payload, ctx): Promise<CapturePageResult> {
      const p = CapturePagePayloadSchema.safeParse(payload);
      if (!p.success) throw invalid("capture.page");
      const d = p.data;
      const h = holder(d.jobId, ctx);
      if (h.passId !== d.passId) {
        throw new ProtocolException(ErrorCode.LeaseLost, "This capture pass was replaced.");
      }
      try {
        jobs.renew(d.jobId, h.lease, now(), ttl);
        const r = capture.commitPage(d.jobId, h.lease, now(), {
          passId: d.passId,
          accountId: xAccountKey(d.accountId),
          collectionId: d.collection,
          cursorIn: d.cursorIn,
          cursorOut: d.cursorOut,
          adapter: d.adapter,
          records: d.records,
          gaps: d.gaps.unavailable + d.gaps.partialThreads,
        });
        if (r.cancelRequested || r.outcome === "cancelled") {
          // A cancel requested in Citspark wins, even over a final page: never acknowledge complete.
          // The page stays committed (CAP-04); an end page already moved the job to cancelled.
          held.delete(d.jobId);
          if (!r.ended) jobs.transition(d.jobId, h.lease, now(), "cancelled");
          throw new ProtocolException(ErrorCode.LeaseLost, "Capture was cancelled in Citspark.");
        }
        if (r.ended) held.delete(d.jobId);
        return { status: r.status, seq: r.seq, outcome: r.outcome, newRecords: r.newRecords };
      } catch (e) {
        if (e instanceof ProtocolException) throw e;
        if (e instanceof AccountMismatchError) {
          held.delete(d.jobId); // The store paused the job in the refused transaction.
          throw new ProtocolException(
            ErrorCode.AccountMismatch,
            "This page belongs to a different X account or collection. Capture paused.",
          );
        }
        if (e instanceof CursorLoopError) {
          settle(d.jobId, h, "failed", "cursor loop: X returned a cursor this pass already read");
          throw new ProtocolException(ErrorCode.CursorLoop, "X repeated a page. Capture stopped.");
        }
        if (e instanceof CheckpointCorruptError) {
          // Fail closed (CAP-04, T02): the pass cannot prove it saw no gaps, so it never completes.
          // The page is not saved and the corrupt record is kept for diagnosis; the job needs
          // attention (failed), and a resume starts a fresh pass that recounts its own gaps.
          settle(
            d.jobId,
            h,
            "failed",
            "checkpoint_corrupt: the saved gap tally of this pass is unreadable",
          );
          throw new ProtocolException(
            ErrorCode.CheckpointCorrupt,
            "Citspark could not read this capture's saved progress. Capture stopped; nothing from this page was saved.",
          );
        }
        if (e instanceof CursorMismatchError || e instanceof ReplayConflictError) {
          throw new ProtocolException(
            ErrorCode.CursorMismatch,
            "This page does not continue the pass. Nothing was saved.",
          );
        }
        if (e instanceof LeaseError) {
          held.delete(d.jobId);
          throw new ProtocolException(ErrorCode.LeaseLost, "This capture is no longer active.");
        }
        if (isDiskFull(e)) {
          settle(d.jobId, h, "paused", "disk_full: the library disk is full; nothing was saved");
          throw new ProtocolException(
            ErrorCode.DiskFull,
            "The disk is full. Capture paused; nothing from this page was saved.",
          );
        }
        throw e;
      }
    },
  };

  const stop: MethodHandler = {
    scope: Scope.CaptureWrite,
    mutation: true,
    async handle(payload, ctx) {
      const p = CaptureStopPayloadSchema.safeParse(payload);
      if (!p.success) throw invalid("capture.stop");
      const d = p.data;
      const h = holder(d.jobId, ctx);
      // Fenced to the exact pass: a delayed stop from a replaced pass must not end its successor.
      if (h.passId !== d.passId) {
        throw new ProtocolException(ErrorCode.LeaseLost, "This capture pass was replaced.");
      }
      held.delete(d.jobId);
      const reason =
        d.retryAfterSec === undefined ? d.reason : `${d.reason}: retry after ${d.retryAfterSec} s`;
      try {
        // Every outcome, cancel included, goes through the held lease: transition validates owner,
        // generation and expiry before it writes anything. A holder whose lease expired and was
        // reclaimed gets LeaseLost and cannot mark its successor's job cancel_requested (CAP-03).
        jobs.transition(
          d.jobId,
          h.lease,
          now(),
          d.outcome,
          d.outcome === "cancelled" ? "cancelled by user" : reason,
        );
      } catch (e) {
        if (e instanceof LeaseError) {
          // Expired but never superseded (same owner and generation): nobody else took the job over,
          // so the user's cancel is honoured and never dropped (CAP-04). Any other outcome from an
          // expired holder, and every outcome from a superseded one, is lease_lost and writes nothing.
          if (d.outcome === "cancelled" && stillOurs(d.jobId, h.lease)) {
            return { state: jobs.cancel(d.jobId, now()).state };
          }
          throw new ProtocolException(ErrorCode.LeaseLost, "This capture is no longer active.");
        }
        throw e;
      }
      return { state: jobs.get(d.jobId).state };
    },
  };

  const renew: MethodHandler = {
    scope: Scope.CaptureWrite,
    mutation: true,
    async handle(payload, ctx): Promise<CaptureRenewResult> {
      const p = CaptureRenewPayloadSchema.safeParse(payload);
      if (!p.success) throw invalid("capture.renew");
      const d = p.data;
      const h = holder(d.jobId, ctx);
      if (h.passId !== d.passId) {
        throw new ProtocolException(ErrorCode.LeaseLost, "This capture pass was replaced.");
      }
      try {
        // Validates owner, generation and expiry: a stale or superseded holder cannot extend anything,
        // and a lease that already ran out is not resurrected.
        jobs.renew(d.jobId, h.lease, now(), ttl);
      } catch (e) {
        if (e instanceof LeaseError) {
          held.delete(d.jobId);
          throw new ProtocolException(ErrorCode.LeaseLost, "This capture is no longer active.");
        }
        throw e;
      }
      if (jobs.get(d.jobId).cancelRequested) {
        // Learn of a cancel requested in Citspark during a long wait, not only at the next page.
        held.delete(d.jobId);
        jobs.transition(d.jobId, h.lease, now(), "cancelled");
        throw new ProtocolException(ErrorCode.LeaseLost, "Capture was cancelled in Citspark.");
      }
      return { renewed: true };
    },
  };

  return {
    [CaptureMethod.start]: start,
    [CaptureMethod.page]: page,
    [CaptureMethod.stop]: stop,
    [CaptureMethod.renew]: renew,
  };
}
