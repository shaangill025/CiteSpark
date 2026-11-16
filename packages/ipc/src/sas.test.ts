import { describe, expect, test } from "vitest";
import {
  commitToNonce,
  desktopCode,
  pairingCode,
  pairingNonce,
  verifyNonceCommitment,
} from "./sas.ts";
import { randomBytes } from "./bytes.ts";

const h = randomBytes(64);

describe("pairing short authentication string", () => {
  test("is six digits and identical for identical inputs", () => {
    const nc = pairingNonce();
    const nd = pairingNonce();
    const code = pairingCode(h, nc, nd);
    expect(code).toMatch(/^[0-9]{6}$/);
    expect(pairingCode(new Uint8Array(h), new Uint8Array(nc), new Uint8Array(nd))).toBe(code);
  });

  test("depends on the handshake hash and on both nonces", () => {
    const nc = pairingNonce();
    const nd = pairingNonce();
    const codes = new Set([
      pairingCode(h, nc, nd),
      pairingCode(randomBytes(64), nc, nd),
      pairingCode(h, pairingNonce(), nd),
      pairingCode(h, nc, pairingNonce()),
    ]);
    // A collision among 4 random 6-digit codes has probability ~6e-6.
    expect(codes.size).toBe(4);
  });

  test("the desktop's code is six digits, deterministic, and independent of the client's code", () => {
    let same = 0;
    for (let i = 0; i < 200; i++) {
      const nc = pairingNonce();
      const nd = pairingNonce();
      const d = desktopCode(h, nc, nd);
      expect(d).toMatch(/^[0-9]{6}$/);
      expect(desktopCode(new Uint8Array(h), new Uint8Array(nc), new Uint8Array(nd))).toBe(d);
      if (d === pairingCode(h, nc, nd)) same++;
    }
    // Different domain labels: equal codes only by chance (~2e-4 over 200 draws).
    expect(same).toBeLessThanOrEqual(1);
  });

  test("codes are roughly uniform over 000000..999999", () => {
    const buckets = new Array(10).fill(0);
    for (let i = 0; i < 2000; i++)
      buckets[Number(pairingCode(h, pairingNonce(), pairingNonce())[0])]++;
    for (const b of buckets) expect(b).toBeGreaterThan(120);
  });

  test("the commitment binds the nonce and the handshake", () => {
    const nd = pairingNonce();
    const c = commitToNonce(h, nd);
    expect(verifyNonceCommitment(h, nd, c)).toBe(true);
    expect(verifyNonceCommitment(h, pairingNonce(), c)).toBe(false);
    expect(verifyNonceCommitment(randomBytes(64), nd, c)).toBe(false);
  });

  test("rejects wrong-length inputs", () => {
    expect(() => pairingCode(randomBytes(32), pairingNonce(), pairingNonce())).toThrow();
    expect(() => commitToNonce(h, randomBytes(16))).toThrow();
  });
});
