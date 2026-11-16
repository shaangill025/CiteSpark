import { ErrorCode, ProtocolException } from "./errors.ts";

/** Toward the core. Frames toward the extension are limited to 1 MB by Chrome native messaging. */
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;
export const EXTENSION_MAX_FRAME_BYTES = 1024 * 1024;
const HEADER_BYTES = 4;

export class FrameError extends ProtocolException {
  constructor(code: ErrorCode, message: string) {
    super(code, message);
    this.name = "FrameError";
  }
}

/** 4-byte big-endian length prefix plus UTF-8 JSON body. */
export function encodeFrame(value: unknown, maxFrameBytes = DEFAULT_MAX_FRAME_BYTES): Buffer {
  const body = Buffer.from(JSON.stringify(value), "utf8");
  if (body.length > maxFrameBytes) {
    throw new FrameError(
      ErrorCode.FrameTooLarge,
      `frame of ${body.length} bytes exceeds limit ${maxFrameBytes}`,
    );
  }
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

/**
 * The Noise prologue (ADR 0006): the exact wire bytes, length prefixes included, of the client hello frame
 * followed by the core's reply frame. The handshake itself belongs to M1-06.
 */
export function helloPrologue(helloFrame: Uint8Array, replyFrame: Uint8Array): Buffer {
  return Buffer.concat([helloFrame, replyFrame]);
}

const utf8 = new TextDecoder("utf-8", { fatal: true });

/** Incremental decoder. Any error is fatal: the stream is desynchronised and the connection must close. */
export class FrameDecoder {
  readonly #max: number;
  #buf: Buffer = Buffer.alloc(0);
  #failed: FrameError | undefined;

  constructor(opts: { maxFrameBytes?: number } = {}) {
    this.#max = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  push(chunk: Uint8Array): unknown[] {
    if (this.#failed) throw this.#failed;
    this.#buf = this.#buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buf, chunk]);
    const out: unknown[] = [];
    try {
      while (this.#buf.length >= HEADER_BYTES) {
        const len = this.#buf.readUInt32BE(0);
        // Reject on the header so an attacker cannot make us buffer an oversized body.
        if (len > this.#max) {
          throw new FrameError(
            ErrorCode.FrameTooLarge,
            `frame of ${len} bytes exceeds limit ${this.#max}`,
          );
        }
        if (len === 0) throw new FrameError(ErrorCode.MalformedFrame, "empty frame");
        if (this.#buf.length < HEADER_BYTES + len) break;
        const body = this.#buf.subarray(HEADER_BYTES, HEADER_BYTES + len);
        this.#buf = this.#buf.subarray(HEADER_BYTES + len);
        out.push(parseBody(body));
      }
    } catch (e) {
      this.#failed = e as FrameError;
      this.#buf = Buffer.alloc(0);
      throw e;
    }
    return out;
  }
}

function parseBody(body: Uint8Array): unknown {
  try {
    return JSON.parse(utf8.decode(body));
  } catch {
    throw new FrameError(ErrorCode.MalformedFrame, "frame body is not valid UTF-8 JSON");
  }
}
