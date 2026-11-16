/** One JSON message per call: a framed socket, a native messaging port, or an in-memory pair in tests. */
export interface MessageTransport {
  send(message: unknown): void;
  /** Rejects with TransportClosedError once the transport is closed and drained. */
  receive(): Promise<unknown>;
  close(): void;
}

export class TransportClosedError extends Error {
  constructor(message = "transport closed", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "TransportClosedError";
  }
}

/** Inbound buffer for transport adapters. */
export class MessageQueue {
  #items: unknown[] = [];
  #waiters: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  #closed: Error | undefined;

  push(message: unknown): void {
    if (this.#closed) return;
    const w = this.#waiters.shift();
    if (w) w.resolve(message);
    else this.#items.push(message);
  }

  close(error: Error = new TransportClosedError()): void {
    if (this.#closed) return;
    this.#closed = error;
    for (const w of this.#waiters.splice(0)) w.reject(error);
  }

  next(): Promise<unknown> {
    if (this.#items.length > 0) return Promise.resolve(this.#items.shift());
    if (this.#closed) return Promise.reject(this.#closed);
    return new Promise((resolve, reject) => this.#waiters.push({ resolve, reject }));
  }
}
