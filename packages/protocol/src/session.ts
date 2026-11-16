import { ErrorCode, ProtocolException } from "./errors.ts";
import type { StreamEvent, StreamState } from "./messages.ts";

type Entry = { fingerprint: string; promise: Promise<unknown>; done: boolean };

/**
 * Remembers every mutation by request ID so a retry after reconnect gets the stored outcome instead of
 * running the mutation again (§14). Failures are remembered too: a half-applied mutation is never repeated.
 * The caller must persist its own durable state; this ledger is the in-process guard.
 */
export class IdempotencyLedger {
  readonly #capacity: number;
  readonly #entries = new Map<string, Entry>();

  constructor(opts: { capacity?: number } = {}) {
    this.#capacity = opts.capacity ?? 10_000;
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
    const entry: Entry = { fingerprint, done: false, promise: undefined as never };
    entry.promise = (async () => {
      try {
        return await run();
      } finally {
        entry.done = true;
      }
    })();
    entry.promise.catch(() => undefined);
    this.#entries.set(requestId, entry);
    this.#evict();
    return entry.promise as Promise<T>;
  }

  #evict(): void {
    for (const [id, e] of this.#entries) {
      if (this.#entries.size <= this.#capacity) return;
      if (e.done) this.#entries.delete(id);
    }
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
