/**
 * Length-prefixed byte frames without parsing the body. Chrome native messaging uses a 4-byte length in
 * native byte order (little-endian on every platform Citspark supports); the core socket uses big-endian.
 */
export class RawFrameReader {
  readonly #max: number;
  readonly #littleEndian: boolean;
  #buf: Buffer = Buffer.alloc(0);

  constructor(opts: { maxFrameBytes: number; littleEndian: boolean }) {
    this.#max = opts.maxFrameBytes;
    this.#littleEndian = opts.littleEndian;
  }

  /** Throws on an empty or oversized frame; the caller must then stop relaying. */
  push(chunk: Uint8Array): Buffer[] {
    this.#buf = this.#buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.#buf, chunk]);
    const out: Buffer[] = [];
    while (this.#buf.length >= 4) {
      const len = this.#littleEndian ? this.#buf.readUInt32LE(0) : this.#buf.readUInt32BE(0);
      if (len === 0 || len > this.#max) throw new Error(`bad frame length ${len}`);
      if (this.#buf.length < 4 + len) break;
      out.push(Buffer.from(this.#buf.subarray(4, 4 + len)));
      this.#buf = this.#buf.subarray(4 + len);
    }
    return out;
  }
}

export function writeRawFrame(body: Uint8Array, littleEndian: boolean): Buffer {
  const header = Buffer.alloc(4);
  if (littleEndian) header.writeUInt32LE(body.length);
  else header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}
