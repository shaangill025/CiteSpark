import CipherState from "noise-handshake/cipher.js";
import { describe, expect, test } from "vitest";
import { toBase64 } from "./bytes.ts";
import { generateStaticKeyPair } from "./keys.ts";
import { Handshake, HandshakeError, type HandshakePattern } from "./handshake.ts";
import { ChannelError, MAX_RECORD_PLAINTEXT, SecureChannel } from "./records.ts";

const prologue = new TextEncoder().encode("p");

function run(
  pattern: HandshakePattern,
  opts: { clientPrologue?: Uint8Array; pin?: Uint8Array } = {},
) {
  const c = generateStaticKeyPair();
  const d = generateStaticKeyPair();
  const init = new Handshake({
    pattern,
    initiator: true,
    staticKeyPair: c,
    prologue: opts.clientPrologue ?? prologue,
    ...(pattern === "IK" ? { remoteStatic: opts.pin ?? d.publicKey } : {}),
  });
  const resp = new Handshake({ pattern, initiator: false, staticKeyPair: d, prologue });
  const transcript: Uint8Array[] = [];
  while (!init.complete || !resp.complete) {
    const [from, to] = init.isMyTurn ? [init, resp] : [resp, init];
    const m = from.writeMessage();
    transcript.push(m);
    to.readMessage(m);
  }
  return { c, d, init, resp, transcript };
}

describe("Noise handshake wrapper", () => {
  test.each(["XX", "IK"] as const)("%s authenticates both static keys and agrees on keys", (p) => {
    const { c, d, init, resp } = run(p);
    const a = init.result();
    const b = resp.result();
    expect(a.remoteStatic).toEqual(d.publicKey);
    expect(b.remoteStatic).toEqual(c.publicKey);
    expect(a.tx).toEqual(b.rx);
    expect(a.rx).toEqual(b.tx);
    expect(a.handshakeHash).toEqual(b.handshakeHash);
  });

  test.each(["XX", "IK"] as const)("%s fails when the prologue (hello) differs", (p) => {
    expect(() => run(p, { clientPrologue: new TextEncoder().encode("q") })).toThrow(HandshakeError);
  });

  test("IK fails when the client pins a different desktop key", () => {
    expect(() => run("IK", { pin: generateStaticKeyPair().publicKey })).toThrow(HandshakeError);
  });

  test("enforces turn order and rejects trailing payload bytes", () => {
    const r = new Handshake({
      pattern: "XX",
      initiator: false,
      staticKeyPair: generateStaticKeyPair(),
      prologue,
    });
    expect(() => r.writeMessage()).toThrow(/not our turn/);
    const i = new Handshake({
      pattern: "XX",
      initiator: true,
      staticKeyPair: generateStaticKeyPair(),
      prologue,
    });
    const m1 = i.writeMessage();
    const smuggled = new Uint8Array([...m1, 1, 2, 3]);
    expect(() => r.readMessage(smuggled)).toThrow(/payload/);
  });

  test("a tampered handshake message is rejected", () => {
    const c = generateStaticKeyPair();
    const d = generateStaticKeyPair();
    const i = new Handshake({
      pattern: "IK",
      initiator: true,
      staticKeyPair: c,
      prologue,
      remoteStatic: d.publicKey,
    });
    const r = new Handshake({ pattern: "IK", initiator: false, staticKeyPair: d, prologue });
    const m1 = i.writeMessage();
    m1[40] = (m1[40] ?? 0) ^ 1;
    expect(() => r.readMessage(m1)).toThrow(HandshakeError);
  });
});

describe("SecureChannel records", () => {
  function pair() {
    const { init, resp } = run("IK");
    return { a: new SecureChannel(init.result()), b: new SecureChannel(resp.result()) };
  }

  test("round-trips messages, including ones larger than one Noise message", () => {
    const { a, b } = pair();
    const big = { s: "x".repeat(MAX_RECORD_PLAINTEXT * 2 + 10) };
    const frames = a.seal(big);
    expect(frames).toHaveLength(3);
    expect(frames.slice(0, 2).map((f) => b.open(f))).toEqual([undefined, undefined]);
    expect(b.open(frames[2]!)).toEqual(big);
    expect(b.open(a.seal({ n: 1 })[0]!)).toEqual({ n: 1 });
  });

  test("ciphertext does not contain the plaintext", () => {
    const { a } = pair();
    const marker = "SYNTHETIC-SECRET-MARKER";
    expect(JSON.stringify(a.seal({ marker }))).not.toContain(marker);
  });

  test.each([
    ["replayed", (f: string[]) => [f[0]!, f[0]!]],
    ["reordered", (f: string[]) => [f[1]!, f[0]!]],
    ["dropped", (f: string[]) => [f[1]!]],
    ["bit-flipped", (f: string[]) => [flip(f[0]!)]],
  ])("a %s record fails and the channel stays failed", (_n, mutate) => {
    const { a, b } = pair();
    const frames = [a.seal({ n: 1 })[0]!.d, a.seal({ n: 2 })[0]!.d];
    const delivered = mutate(frames);
    expect(() => {
      for (const d of delivered) b.open({ type: "rec", d });
    }).toThrow(ChannelError);
    expect(b.failed).toBe(true);
    expect(() => b.open({ type: "rec", d: frames[0]! })).toThrow(ChannelError);
  });

  test("records from a different session (injection) fail", () => {
    const one = pair();
    const two = pair();
    expect(() => one.b.open(two.a.seal({ evil: true })[0]!)).toThrow(ChannelError);
  });

  test("assembled messages above the limit are rejected", () => {
    const { init, resp } = run("IK");
    const a = new SecureChannel(init.result());
    const b = new SecureChannel(resp.result(), { maxMessageBytes: 100_000 });
    const frames = a.seal({ s: "x".repeat(150_000) });
    expect(() => frames.forEach((f) => b.open(f))).toThrow(/too large/);
  });

  test.each([
    ["empty", 0],
    ["one-byte", 1],
  ])("a %s non-final record is refused, so fragments cannot pile up", (_n, len) => {
    const { init, resp } = run("IK");
    // A peer that holds the session keys but does not follow `seal`'s chunking.
    const peer = new CipherState(init.result().tx);
    const b = new SecureChannel(resp.result(), { maxMessageBytes: 4096 });
    const more = new Uint8Array(len + 1); // flag byte 0 = more records follow
    const rec = () => ({ type: "rec" as const, d: toBase64(peer.encrypt(more)) });
    expect(() => {
      for (let i = 0; i < 1000; i++) b.open(rec());
    }).toThrow(ChannelError);
    expect(b.failed).toBe(true);
  });

  test("a final record may be short, and a message of exactly one chunk stays one record", () => {
    const { a, b } = pair();
    const exact = { s: "x".repeat(MAX_RECORD_PLAINTEXT - 8) }; // {"s":"…"} adds 8 bytes
    const frames = a.seal(exact);
    expect(frames).toHaveLength(1);
    expect(b.open(frames[0]!)).toEqual(exact);
    const two = { s: "y".repeat(MAX_RECORD_PLAINTEXT) };
    const f2 = a.seal(two);
    expect(f2).toHaveLength(2);
    expect(b.open(f2[0]!)).toBeUndefined();
    expect(b.open(f2[1]!)).toEqual(two);
  });
});

function flip(b64: string): string {
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  bytes[bytes.length - 1]! ^= 1;
  return btoa(String.fromCharCode(...bytes));
}
