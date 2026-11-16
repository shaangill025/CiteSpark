import { describe, expect, test } from "vitest";
import {
  canonicalJson,
  CLIENT_GRANTABLE_SCOPES,
  HandshakeFrameSchema,
  helloPrologue,
  MAX_NOISE_MESSAGE_BYTES,
  PairClientMessageSchema,
  PairCoreMessageSchema,
  RecordFrameSchema,
  Scope,
  type Hello,
} from "./index.ts";

const hello: Hello = {
  type: "hello",
  versions: { min: 1, max: 1 },
  client: { kind: "extension", version: "0.1.0" },
  channel: "session",
};

describe("canonical prologue", () => {
  test("is independent of key order, so a re-serialising relay (Chrome) cannot break it", () => {
    const reordered = {
      channel: "session",
      client: { version: "0.1.0", kind: "extension" },
      versions: { max: 1, min: 1 },
      type: "hello",
    } as Hello;
    const reply = { type: "hello.ok", version: 1, core: { version: "0.0.0" } } as const;
    expect(helloPrologue(reordered, reply)).toEqual(helloPrologue(hello, reply));
  });

  test("changes when any field of hello or the reply changes (downgrade or tamper is detected)", () => {
    const reply = { type: "hello.ok", version: 1, core: { version: "0.0.0" } } as const;
    const base = helloPrologue(hello, reply);
    expect(helloPrologue({ ...hello, channel: "pair" }, reply)).not.toEqual(base);
    expect(helloPrologue(hello, { ...reply, version: 2 })).not.toEqual(base);
  });

  test("canonicalJson sorts keys recursively and rejects non-JSON values", () => {
    expect(canonicalJson({ b: [{ d: 1, c: 2 }], a: "x" })).toBe('{"a":"x","b":[{"c":2,"d":1}]}');
    expect(() => canonicalJson({ a: undefined })).toThrow();
    expect(() => canonicalJson(Number.NaN)).toThrow();
  });
});

describe("channel frames", () => {
  test("handshake and record frames carry strict base64 within the Noise message limit", () => {
    const max = btoa("x".repeat(MAX_NOISE_MESSAGE_BYTES));
    expect(HandshakeFrameSchema.safeParse({ type: "hs", d: "AAEC" }).success).toBe(true);
    expect(RecordFrameSchema.safeParse({ type: "rec", d: max }).success).toBe(true);
    expect(RecordFrameSchema.safeParse({ type: "rec", d: max + "AAAA" }).success).toBe(false);
    expect(RecordFrameSchema.safeParse({ type: "rec", d: "not base64!" }).success).toBe(false);
    expect(RecordFrameSchema.safeParse({ type: "rec", d: "" }).success).toBe(false);
    expect(RecordFrameSchema.safeParse({ type: "rec", d: "AAEC", x: 1 }).success).toBe(false);
  });
});

describe("pairing messages and scopes", () => {
  test("clients.manage is never grantable to a paired client", () => {
    expect(CLIENT_GRANTABLE_SCOPES).not.toContain(Scope.ClientsManage);
    expect(
      PairClientMessageSchema.safeParse({ type: "pair.request", scopes: [Scope.ClientsManage] })
        .success,
    ).toBe(false);
    expect(
      PairClientMessageSchema.safeParse({ type: "pair.request", scopes: [Scope.CaptureWrite] })
        .success,
    ).toBe(true);
  });

  test("pair.request rejects empty or duplicate scope lists", () => {
    expect(PairClientMessageSchema.safeParse({ type: "pair.request", scopes: [] }).success).toBe(
      false,
    );
    expect(
      PairClientMessageSchema.safeParse({
        type: "pair.request",
        scopes: [Scope.CaptureWrite, Scope.CaptureWrite],
      }).success,
    ).toBe(false);
  });

  test("the pairing code never travels on the wire", () => {
    const confirm = { type: "pair.confirm", code: "123456" };
    expect(PairClientMessageSchema.safeParse(confirm).success).toBe(false);
  });

  test("nonces and commitments are exactly 32 bytes", () => {
    const n32 = btoa("n".repeat(32));
    const n31 = btoa("n".repeat(31));
    expect(PairCoreMessageSchema.safeParse({ type: "pair.commit", commit: n32 }).success).toBe(
      true,
    );
    expect(PairCoreMessageSchema.safeParse({ type: "pair.commit", commit: n31 }).success).toBe(
      false,
    );
    expect(PairClientMessageSchema.safeParse({ type: "pair.nonce", nonce: n32 }).success).toBe(
      true,
    );
  });
});
