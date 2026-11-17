import { Worker } from "node:worker_threads";
import type { ExtractionInput, WorkerReply } from "./extract-protocol.ts";

/**
 * ENR-03: untrusted bodies are decoded and parsed in worker threads, never on the caller's thread, so
 * a page that is expensive to parse cannot stall the caller's event loop. A worker still running at
 * the caller's deadline is terminated, not abandoned, and each worker has its own heap limit. A pool
 * bounds how many workers run at once and how many requests may wait for one.
 */

/** Under Vitest and type stripping this module runs as `.ts`; compiled, both files are `.js`. */
const WORKER_ENTRY = new URL(
  import.meta.url.endsWith(".ts") ? "./extract-worker.ts" : "./extract-worker.js",
  import.meta.url,
);

export interface ExtractionPoolLimits {
  /** Workers alive at once, counting terminated workers until they have exited. */
  maxWorkers: number;
  /** Requests that may wait for a worker; further requests are rejected as `busy`. */
  maxQueued: number;
  /** V8 old-generation heap limit per worker, in MiB. */
  maxHeapMb: number;
}

/**
 * PROPOSED defaults, not measured guarantees: two workers, 32 waiting requests, 512 MiB heap per
 * worker. A synthetic 5 MiB page of densely repeated empty elements needed more than 256 MiB.
 */
export const DEFAULT_EXTRACTION_LIMITS: ExtractionPoolLimits = {
  maxWorkers: 2,
  maxQueued: 32,
  maxHeapMb: 512,
};

/**
 * The outcome of one isolated extraction. `deadline`: the deadline passed while waiting for or
 * running a worker. `busy`: the pool's queue was full, so nothing about the page is known.
 */
export type IsolatedExtraction = WorkerReply | { kind: "deadline" } | { kind: "busy" };

interface Waiter {
  admit: () => void;
}

export class ExtractionPool {
  readonly limits: ExtractionPoolLimits;
  readonly #entry: URL;
  #running = 0;
  readonly #queue: Waiter[] = [];

  /** `entry` is a test seam for fault-injection workers; production callers leave it unset. */
  constructor(limits: Partial<ExtractionPoolLimits> = {}, entry: URL = WORKER_ENTRY) {
    this.limits = { ...DEFAULT_EXTRACTION_LIMITS, ...limits };
    this.#entry = entry;
  }

  /** Workers currently alive, including terminated ones that have not exited yet. */
  get running(): number {
    return this.#running;
  }

  /** Requests waiting for a worker. */
  get queued(): number {
    return this.#queue.length;
  }

  /**
   * Decode and extract `input` in a fresh worker. Settles exactly once: with the worker's reply,
   * `busy` when the queue is full, or `deadline` once `deadlineAt` (a `performance.now()` time)
   * passes while waiting or running, in which case the worker is terminated. A worker that fails or
   * exits without replying rejects (a defect, not a page gap). The worker's slot is released only
   * after it has exited.
   */
  extract(input: ExtractionInput, deadlineAt: number): Promise<IsolatedExtraction> {
    return new Promise((resolve, reject) => {
      if (deadlineAt <= performance.now()) {
        resolve({ kind: "deadline" });
        return;
      }
      let settled = false;
      let worker: Worker | undefined;
      const finish = (settle: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const queued = this.#queue.indexOf(waiter);
        if (queued !== -1) this.#queue.splice(queued, 1);
        settle();
        void worker?.terminate();
      };
      const waiter: Waiter = {
        admit: () => {
          this.#running++;
          try {
            worker = new Worker(this.#entry, {
              workerData: input,
              resourceLimits: { maxOldGenerationSizeMb: this.limits.maxHeapMb },
            });
          } catch (error) {
            this.#release();
            finish(() => reject(error as Error));
            return;
          }
          worker.once("exit", (code) => {
            this.#release();
            finish(() =>
              reject(new Error(`extraction worker exited with code ${code} before replying`)),
            );
          });
          worker.once("message", (reply: WorkerReply) => finish(() => resolve(reply)));
          worker.once("error", (error) => finish(() => reject(error)));
        },
      };
      const timer = setTimeout(
        () => finish(() => resolve({ kind: "deadline" })),
        deadlineAt - performance.now(),
      );
      if (this.#running < this.limits.maxWorkers) waiter.admit();
      else if (this.#queue.length < this.limits.maxQueued) this.#queue.push(waiter);
      else finish(() => resolve({ kind: "busy" }));
    });
  }

  #release(): void {
    this.#running--;
    const next = this.#queue.shift();
    next?.admit();
  }
}

/** The process-wide pool `captureLink` uses unless given another. */
export const defaultExtractionPool = new ExtractionPool();
