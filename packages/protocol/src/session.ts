import { ErrorCode, ProtocolException } from "./errors.ts";
import type { StreamEvent, StreamState } from "./messages.ts";

type Entry = { fingerprint: string; promise: Promise<unknown> };

/**
 * Remembers every mutation by request ID so a retry after reconnect gets the stored outcome instead of
 * running the mutation again (§14). Failures are remembered too: a half-applied mutation is never repeated.
 *
 * The ledger never forgets an ID it has accepted: forgetting one would let a late retry run the mutation a
 * second time. When `capacity` IDs are held it fails closed and rejects *new* IDs with
 * `idempotency_exhausted`, while replays of known IDs keep returning their stored outcome. A durable outcome
 * store that lets old entries leave memory safely belongs with transport wiring (M1-06). The ledger must
 * outlive individual connections (for example one per paired client), or reconnects would bypass it.
 */
export class IdempotencyLedger {
  readonly #capacity: number;
  readonly #entries = new Map<string, Entry>();

  constructor(opts: { capacity?: number } = {}) {
    const capacity = opts.capacity ?? 10_000;
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.#capacity = capacity;
  }

  has(requestId: string): boolean {
    return this.#entries.has(requestId);
  }

  execute<T>(requestId: string, fingerprint: string, run: () => Promise<T>): Promise<T> {
    const existing = this.#entries.get(requestId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return Promise.reject(
          new ProtocolException(
            ErrorCode.IdempotencyConflict,
            "request ID reused with a different payload",
          ),
        );
      }
      return existing.promise as Promise<T>;
    }
    if (this.#entries.size >= this.#capacity) {
      return Promise.reject(
        new ProtocolException(
          ErrorCode.IdempotencyExhausted,
          "idempotency ledger is full; refusing a new mutation rather than forgetting an old one",
        ),
      );
    }
    // The async wrapper turns a synchronous throw from `run` into a remembered rejection too.
    const entry: Entry = { fingerprint, promise: (async () => run())() };
    entry.promise.catch(() => undefined);
    this.#entries.set(requestId, entry);
    return entry.promise as Promise<T>;
  }
}

export class StreamSender {
  readonly streamId: string;
  #seq = 0;
  #terminal: StreamState | undefined;

  constructor(streamId: string) {
    this.streamId = streamId;
  }

  data(data: StreamEvent["data"]): StreamEvent {
    this.#assertOpen();
    return {
      streamId: this.streamId,
      seq: this.#seq++,
      state: "open",
      ...(data === undefined ? {} : { data }),
    };
  }

  end(state: Exclude<StreamState, "open">, error?: StreamEvent["error"]): StreamEvent {
    this.#assertOpen();
    this.#terminal = state;
    return { streamId: this.streamId, seq: this.#seq++, state, ...(error ? { error } : {}) };
  }

  #assertOpen(): void {
    if (this.#terminal)
      throw new Error(`stream ${this.streamId} already ended (${this.#terminal})`);
  }
}

export type AcceptResult = "accepted" | "duplicate" | "gap" | "after_terminal" | "wrong_stream";

/** Tracks the next expected sequence number; after a gap or reconnect, ask the sender to resume from `resumeFrom`. */
export class StreamReceiver {
  readonly streamId: string;
  #next = 0;
  #terminal: StreamState | undefined;

  constructor(streamId: string) {
    this.streamId = streamId;
  }

  get resumeFrom(): number {
    return this.#next;
  }

  get terminal(): StreamState | undefined {
    return this.#terminal;
  }

  accept(ev: Pick<StreamEvent, "streamId" | "seq" | "state">): AcceptResult {
    if (ev.streamId !== this.streamId) return "wrong_stream";
    if (this.#terminal) return ev.seq < this.#next ? "duplicate" : "after_terminal";
    if (ev.seq < this.#next) return "duplicate";
    if (ev.seq > this.#next) return "gap";
    this.#next++;
    if (ev.state !== "open") this.#terminal = ev.state;
    return "accepted";
  }
}
