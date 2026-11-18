import {
  ErrorCode,
  jsonByteLength,
  protocolError,
  ResponseSchema,
  SUPPORTED_VERSIONS,
  UI_PROTOCOL_LIMITS,
  UiHelloReplySchema,
  type ProtocolErrorBody,
} from "@citspark/protocol";

type Json = ReturnType<typeof JSON.parse>;

/** What the renderer may ask for through `window.citspark.request`. */
export interface RendererRequest {
  method: string;
  mutation: boolean;
  payload: Json;
}

export type ParseResult =
  { ok: true; value: RendererRequest } | { ok: false; error: ProtocolErrorBody };

const KEYS = ["method", "mutation", "payload"].sort().join(",");

function isPlainJson(value: unknown, depth = 0): boolean {
  if (depth > 32) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isPlainJson(v, depth + 1));
  if (typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    if (proto !== Object.prototype && proto !== null) return false;
    return Object.values(value as object).every((v) => isPlainJson(v, depth + 1));
  }
  return false;
}

/**
 * Validates one renderer request before anything is relayed. The renderer is unprivileged: it may name a
 * method and send JSON, nothing else. The core validates again; this check keeps junk out of the core.
 */
export function parseRendererRequest(input: unknown): ParseResult {
  const invalid = (): ParseResult => ({
    ok: false,
    error: protocolError(ErrorCode.InvalidMessage, "Malformed request."),
  });
  if (input === null || typeof input !== "object" || Array.isArray(input)) return invalid();
  if (Object.getPrototypeOf(input) !== Object.prototype) return invalid();
  if (Object.keys(input).sort().join(",") !== KEYS) return invalid();
  const { method, mutation, payload } = input as Record<string, unknown>;
  if (typeof method !== "string" || method.length < 1 || method.length > 128) return invalid();
  if (typeof mutation !== "boolean") return invalid();
  if (!isPlainJson(payload)) return invalid();
  const size = jsonByteLength(payload);
  if (size === undefined || size > UI_PROTOCOL_LIMITS.maxMessageBytes - 512) {
    return {
      ok: false,
      error: protocolError(ErrorCode.FrameTooLarge, "The request is too large."),
    };
  }
  return { ok: true, value: { method, mutation, payload: payload as Json } };
}

/** The version from the core's `ui.hello` reply, or `undefined` unless it is a valid `ui.hello.ok` this shell supports. */
export function helloVersion(body: unknown): number | undefined {
  const parsed = UiHelloReplySchema.safeParse(body);
  if (!parsed.success || parsed.data.type !== "ui.hello.ok") return undefined;
  const { version } = parsed.data;
  return version >= SUPPORTED_VERSIONS.min && version <= SUPPORTED_VERSIONS.max
    ? version
    : undefined;
}

type Reply = Record<string, unknown>;

export interface BridgeOptions {
  /** Relays one envelope to the core; returns false if the core cannot take it now. */
  send(envelopeId: number, body: unknown): boolean | void;
  timeoutMs?: number;
  maxInFlight?: number;
}

/**
 * Turns renderer requests into protocol requests for the core and matches the replies. Bounded: at most
 * `maxInFlight` outstanding requests, each failing after `timeoutMs`, and replies over the size limit are
 * dropped. Every outcome resolves to a protocol response; nothing from the core is passed on unchecked.
 */
export class RendererBridge {
  readonly #opts: Required<BridgeOptions>;
  readonly #pending = new Map<
    number,
    { requestId: string; resolve: (r: Reply) => void; timer: ReturnType<typeof setTimeout> }
  >();
  #next = 1;
  #version: number = SUPPORTED_VERSIONS.max;

  constructor(opts: BridgeOptions) {
    this.#opts = {
      timeoutMs: UI_PROTOCOL_LIMITS.requestTimeoutMs,
      maxInFlight: UI_PROTOCOL_LIMITS.maxInFlight,
      ...opts,
    };
  }

  get inFlight(): number {
    return this.#pending.size;
  }

  /** The protocol version the core agreed to in `ui.hello`. */
  setVersion(version: number): void {
    this.#version = version;
  }

  request(req: RendererRequest): Promise<Reply> {
    const envelopeId = this.#next++;
    const requestId = `ui-${envelopeId}`;
    const fail = (code: ProtocolErrorBody["code"], message: string): Reply => ({
      v: this.#version,
      id: requestId,
      ok: false,
      error: protocolError(code, message),
    });
    if (this.#pending.size >= this.#opts.maxInFlight) {
      return Promise.resolve(
        fail(ErrorCode.Internal, "Too many requests are waiting for the core."),
      );
    }
    return new Promise<Reply>((resolve) => {
      const timer = setTimeout(() => {
        this.#pending.delete(envelopeId);
        resolve(fail(ErrorCode.Internal, "The core did not answer in time."));
      }, this.#opts.timeoutMs);
      this.#pending.set(envelopeId, { requestId, resolve, timer });
      const body = { v: this.#version, id: requestId, ...req };
      let sent: boolean | void;
      try {
        sent = this.#opts.send(envelopeId, body);
      } catch {
        sent = false;
      }
      if (sent === false)
        this.#settle(envelopeId, fail(ErrorCode.Internal, "The core is not running."));
    });
  }

  /** A reply from the core. Unknown envelopes and replies for a different request ID are ignored. */
  deliver(envelopeId: number, body: unknown): void {
    const entry = this.#pending.get(envelopeId);
    if (!entry) return;
    const reply = body as Reply | null;
    if (reply === null || typeof reply !== "object" || reply.id !== entry.requestId) return;
    const size = jsonByteLength(reply);
    if (size === undefined || size > UI_PROTOCOL_LIMITS.maxMessageBytes) {
      this.#settle(envelopeId, {
        v: this.#version,
        id: entry.requestId,
        ok: false,
        error: protocolError(ErrorCode.FrameTooLarge, "The core's reply was too large."),
      });
      return;
    }
    // The renderer gets only replies that match the wire contract and the negotiated version.
    const parsed = ResponseSchema.safeParse(reply);
    if (!parsed.success || parsed.data.v !== this.#version) {
      this.#settle(envelopeId, {
        v: this.#version,
        id: entry.requestId,
        ok: false,
        error: protocolError(ErrorCode.Internal, "The core sent an invalid reply."),
      });
      return;
    }
    this.#settle(envelopeId, parsed.data);
  }

  /** The core stopped or restarted: every waiting request fails now rather than at its timeout. */
  failAll(message: string): void {
    for (const [id, entry] of [...this.#pending]) {
      this.#settle(id, {
        v: this.#version,
        id: entry.requestId,
        ok: false,
        error: protocolError(ErrorCode.Internal, message),
      });
    }
  }

  #settle(envelopeId: number, reply: Reply): void {
    const entry = this.#pending.get(envelopeId);
    if (!entry) return;
    this.#pending.delete(envelopeId);
    clearTimeout(entry.timer);
    entry.resolve(reply);
  }
}
