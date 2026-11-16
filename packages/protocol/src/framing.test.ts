import { describe, expect, test, vi } from "vitest";
import { DEFAULT_MAX_FRAME_BYTES, FrameDecoder, FrameError, encodeFrame } from "./framing.ts";

const enc = (v: unknown) => encodeFrame(v);

describe("framing", () => {
  test("round-trips a JSON body with a 4-byte big-endian length prefix", () => {
    const bytes = enc({ a: "é" });
    expect(bytes.readUInt32BE(0)).toBe(bytes.length - 4);
    const d = new FrameDecoder();
    expect(d.push(bytes)).toEqual([{ a: "é" }]);
  });

  test("reassembles frames split across chunks and splits coalesced frames", () => {
    const all = Buffer.concat([enc({ n: 1 }), enc({ n: 2 })]);
    const d = new FrameDecoder();
    const out: unknown[] = [];
    for (let i = 0; i < all.length; i++) out.push(...d.push(all.subarray(i, i + 1)));
    expect(out).toEqual([{ n: 1 }, { n: 2 }]);
    expect(new FrameDecoder().push(all)).toHaveLength(2);
  });

  test("fragmented frames are copied once, not re-concatenated per chunk (no quadratic copying)", () => {
    const frame = enc({ s: "y".repeat(256 * 1024) });
    const chunks: Buffer[] = [];
    for (let i = 0; i < frame.length; i += 1024) chunks.push(frame.subarray(i, i + 1024));
    const concat = vi.spyOn(Buffer, "concat");
    const from = vi.spyOn(Buffer, "from");
    try {
      const d = new FrameDecoder();
      const out: unknown[] = [];
      for (const c of chunks) out.push(...d.push(c));
      expect(out).toEqual([{ s: "y".repeat(256 * 1024) }]);
      // Old behaviour: one full-buffer copy per chunk (~260 calls). Allow a constant, not O(chunks).
      expect(concat.mock.calls.length + from.mock.calls.length).toBeLessThanOrEqual(2);
    } finally {
      concat.mockRestore();
      from.mockRestore();
    }
  });

  test("a header split across chunks is reassembled, and the oversize check still fires", () => {
    const d = new FrameDecoder({ maxFrameBytes: 16 });
    expect(d.push(Buffer.from([0, 0]))).toEqual([]);
    expect(() => d.push(Buffer.from([0, 17]))).toThrowError(
      expect.objectContaining({ code: "frame_too_large" }),
    );
  });

  test("decoded frames do not alias caller buffers that are later reused", () => {
    const d = new FrameDecoder();
    const frame = enc({ a: 1 });
    const chunk = Buffer.from(frame.subarray(0, 6));
    expect(d.push(chunk)).toEqual([]);
    chunk.fill(0x7b);
    expect(d.push(frame.subarray(6))).toEqual([{ a: 1 }]);
  });

  test("empty chunks are harmless", () => {
    const d = new FrameDecoder();
    expect(d.push(new Uint8Array(0))).toEqual([]);
    expect(d.push(enc({ ok: true }))).toEqual([{ ok: true }]);
  });

  test("rejects an oversized frame from the header alone, before buffering the body", () => {
    const d = new FrameDecoder({ maxFrameBytes: 16 });
    const header = Buffer.alloc(4);
    header.writeUInt32BE(17);
    expect(() => d.push(header)).toThrowError(expect.objectContaining({ code: "frame_too_large" }));
  });

  test("rejects oversized frames on encode and keeps decoder poisoned after an error", () => {
    expect(() => encodeFrame({ s: "x".repeat(64) }, 16)).toThrow(FrameError);
    const d = new FrameDecoder({ maxFrameBytes: 16 });
    expect(() => d.push(Buffer.from([0, 0, 0, 0xff]))).toThrow(FrameError);
    expect(() => d.push(enc({}))).toThrow(FrameError);
  });

  test("rejects zero-length, invalid UTF-8 and non-JSON bodies", () => {
    expect(() => new FrameDecoder().push(Buffer.alloc(4))).toThrowError(
      expect.objectContaining({ code: "malformed_frame" }),
    );
    const bad = Buffer.concat([Buffer.from([0, 0, 0, 1]), Buffer.from([0xff])]);
    expect(() => new FrameDecoder().push(bad)).toThrowError(
      expect.objectContaining({ code: "malformed_frame" }),
    );
    const notJson = Buffer.concat([Buffer.from([0, 0, 0, 3]), Buffer.from("abc")]);
    expect(() => new FrameDecoder().push(notJson)).toThrowError(
      expect.objectContaining({ code: "malformed_frame" }),
    );
  });

  test("default limit is the 8 MB core limit", () => {
    expect(DEFAULT_MAX_FRAME_BYTES).toBe(8 * 1024 * 1024);
  });
});
