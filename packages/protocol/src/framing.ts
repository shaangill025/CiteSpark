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

/**
 * Incremental decoder. Any error is fatal: the stream is desynchronised and the connection must close.
 * Each input byte is copied exactly once: header bytes into a fixed 4-byte buffer, body bytes into a buffer
 * allocated once the (size-checked) header is complete. Fragmented frames therefore cost linear work.
 */
export class FrameDecoder {
  readonly #max: number;
  readonly #header = new Uint8Array(HEADER_BYTES);
  #headerFill = 0;
  #body: Uint8Array | undefined;
  #bodyFill = 0;
  #failed: FrameError | undefined;

  constructor(opts: { maxFrameBytes?: number } = {}) {
    this.#max = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  push(chunk: Uint8Array): unknown[] {
    if (this.#failed) throw this.#failed;
    const out: unknown[] = [];
    try {
      let off = 0;
      while (off < chunk.length) {
        if (this.#body === undefined) {
          const n = Math.min(HEADER_BYTES - this.#headerFill, chunk.length - off);
          this.#header.set(chunk.subarray(off, off + n), this.#headerFill);
          this.#headerFill += n;
          off += n;
          if (this.#headerFill < HEADER_BYTES) break;
          const len = new DataView(this.#header.buffer).getUint32(0, false);
          // Reject on the header so an attacker cannot make us buffer an oversized body.
          if (len > this.#max) {
            throw new FrameError(
              ErrorCode.FrameTooLarge,
              `frame of ${len} bytes exceeds limit ${this.#max}`,
            );
          }
          if (len === 0) throw new FrameError(ErrorCode.MalformedFrame, "empty frame");
          this.#body = new Uint8Array(len);
          this.#bodyFill = 0;
          continue;
        }
        const n = Math.min(this.#body.length - this.#bodyFill, chunk.length - off);
        this.#body.set(chunk.subarray(off, off + n), this.#bodyFill);
        this.#bodyFill += n;
        off += n;
        if (this.#bodyFill === this.#body.length) {
          const body = this.#body;
          this.#body = undefined;
          this.#headerFill = 0;
          out.push(parseBody(body));
        }
      }
    } catch (e) {
      this.#failed = e as FrameError;
      this.#body = undefined;
      this.#headerFill = 0;
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
