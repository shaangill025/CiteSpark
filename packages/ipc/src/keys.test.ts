import { describe, expect, test } from "vitest";
import {
  generateStaticKeyPair,
  generateWrappingKey,
  unwrapStaticKey,
  wrapStaticKey,
} from "./keys.ts";
import { toBase64 } from "./bytes.ts";

describe("wrapped client static key (ADR 0011)", () => {
  test("round-trips, and the stored form holds no raw secret", async () => {
    const kp = generateStaticKeyPair();
    const wk = await generateWrappingKey();
    const wrapped = await wrapStaticKey(kp, wk);
    expect(JSON.stringify(wrapped)).not.toContain(toBase64(kp.secretKey));
    const back = await unwrapStaticKey(wrapped, wk);
    expect(back.secretKey).toEqual(kp.secretKey);
    expect(back.publicKey).toEqual(kp.publicKey);
  });

  test("the wrapping key is non-extractable", async () => {
    const wk = await generateWrappingKey();
    expect(wk.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", wk)).rejects.toThrow();
  });

  test("a different wrapping key, tampered blob, or swapped public key fails", async () => {
    const kp = generateStaticKeyPair();
    const wk = await generateWrappingKey();
    const wrapped = await wrapStaticKey(kp, wk);
    await expect(unwrapStaticKey(wrapped, await generateWrappingKey())).rejects.toThrow();
    const other = toBase64(generateStaticKeyPair().publicKey);
    await expect(unwrapStaticKey({ ...wrapped, publicKey: other }, wk)).rejects.toThrow();
    const sealed = wrapped.sealed.startsWith("A")
      ? "B" + wrapped.sealed.slice(1)
      : "A" + wrapped.sealed.slice(1);
    await expect(unwrapStaticKey({ ...wrapped, sealed }, wk)).rejects.toThrow();
  });
});
