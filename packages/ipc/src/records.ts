import CipherState from "noise-handshake/cipher.js";
import {
  DEFAULT_MAX_FRAME_BYTES,
  MAX_NOISE_MESSAGE_BYTES,
  type RecordFrame,
} from "@citspark/protocol";
import { fromBase64, toBase64 } from "./bytes.ts";
import type { HandshakeResult } from "./handshake.ts";

const TAG_BYTES = 16;
const FLAG_MORE = 0;
const FLAG_FINAL = 1;
export const MAX_RECORD_PLAINTEXT = MAX_NOISE_MESSAGE_BYTES - TAG_BYTES - 1;
/** The library writes the counter as a uint32; stop well before it could wrap and reuse a nonce. */
const MAX_NONCE = 0xffff_fff0;

export class ChannelError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ChannelError";
  }
}

const utf8 = new TextDecoder("utf-8", { fatal: true });
const encoder = new TextEncoder();

/**
 * Noise transport phase. Every application message is JSON, split into records of at most one Noise message
 * each. Each record is ChaCha20-Poly1305 with an implicit counter nonce, so a relay cannot read, change,
 * drop, reorder, replay or inject a record without the next decrypt failing. Any failure is permanent.
 */
export class SecureChannel {
  readonly #tx: CipherState;
  readonly #rx: CipherState;
  readonly #maxMessageBytes: number;
  #parts: Uint8Array[] = [];
  #partBytes = 0;
  #failed: ChannelError | undefined;

  constructor(keys: HandshakeResult, opts: { maxMessageBytes?: number } = {}) {
    this.#tx = new CipherState(keys.tx);
    this.#rx = new CipherState(keys.rx);
    this.#maxMessageBytes = opts.maxMessageBytes ?? DEFAULT_MAX_FRAME_BYTES;
  }

  get failed(): boolean {
    return this.#failed !== undefined;
  }

  seal(message: unknown): RecordFrame[] {
    this.#assertOk();
    const body = encoder.encode(JSON.stringify(message));
    if (body.length > this.#maxMessageBytes) {
      throw new ChannelError(`message of ${body.length} bytes exceeds ${this.#maxMessageBytes}`);
    }
    const frames: RecordFrame[] = [];
    for (let off = 0; off === 0 || off < body.length; off += MAX_RECORD_PLAINTEXT) {
      const chunk = body.subarray(off, off + MAX_RECORD_PLAINTEXT);
      const last = off + MAX_RECORD_PLAINTEXT >= body.length;
      const plain = new Uint8Array(chunk.length + 1);
      plain[0] = last ? FLAG_FINAL : FLAG_MORE;
      plain.set(chunk, 1);
      if (this.#tx.nonce >= MAX_NONCE) this.#fail("send nonce exhausted");
      frames.push({ type: "rec", d: toBase64(this.#tx.encrypt(plain)) });
    }
    return frames;
  }

  /** Returns the message once its final record arrives, otherwise undefined. */
  open(frame: RecordFrame): unknown {
    this.#assertOk();
    if (this.#rx.nonce >= MAX_NONCE) this.#fail("receive nonce exhausted");
    let plain: Uint8Array;
    try {
      plain = this.#rx.decrypt(fromBase64(frame.d));
    } catch (e) {
      this.#fail("record failed authentication", e);
    }
    const flag = plain[0];
    if (flag !== FLAG_MORE && flag !== FLAG_FINAL) this.#fail("bad record flag");
    this.#partBytes += plain.length - 1;
    if (this.#partBytes > this.#maxMessageBytes) this.#fail("message too large");
    this.#parts.push(plain.subarray(1));
    if (flag === FLAG_MORE) return undefined;
    const body = new Uint8Array(this.#partBytes);
    let off = 0;
    for (const p of this.#parts) {
      body.set(p, off);
      off += p.length;
    }
    this.#parts = [];
    this.#partBytes = 0;
    try {
      return JSON.parse(utf8.decode(body));
    } catch (e) {
      this.#fail("record body is not UTF-8 JSON", e);
    }
  }

  #assertOk(): void {
    if (this.#failed) throw this.#failed;
  }

  #fail(message: string, cause?: unknown): never {
    this.#failed = new ChannelError(message, { cause });
    this.#parts = [];
    throw this.#failed;
  }
}
