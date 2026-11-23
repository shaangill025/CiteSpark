import { describe, expect, test } from "vitest";
import { generateStaticKeyPair, toBase64 } from "@citspark/ipc";
import { memoryKv, type Kv } from "../src/background/pacer.ts";
import { PairingStore } from "../src/background/keystore.ts";

const dump = async (kv: Kv) => JSON.stringify(await kv.get("pairing"));

describe("client key storage (ADR 0011 wrapped key)", () => {
  test("stores only the AES-GCM-wrapped static key and the pinned desktop key", async () => {
    const kv = memoryKv();
    const store = new PairingStore(kv);
    const kp = generateStaticKeyPair();
    const desktop = generateStaticKeyPair().publicKey;
    await store.save(kp, { clientId: "client-1", desktopPublicKey: desktop });
    const raw = await dump(kv);
    expect(raw).not.toContain(toBase64(kp.secretKey));
    const rec = (await kv.get<{ wrappingKey: CryptoKey }>("pairing"))!;
    expect(rec.wrappingKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("raw", rec.wrappingKey)).rejects.toThrow();
    const loaded = await store.load();
    expect(loaded?.clientId).toBe("client-1");
    expect(loaded?.keyPair.secretKey).toEqual(kp.secretKey);
    expect(loaded?.desktopPublicKey).toEqual(desktop);
  });

  test("unpaired and cleared states load as null", async () => {
    const kv = memoryKv();
    const store = new PairingStore(kv);
    expect(await store.load()).toBeNull();
    await store.save(generateStaticKeyPair(), {
      clientId: "c",
      desktopPublicKey: generateStaticKeyPair().publicKey,
    });
    await store.clear();
    expect(await store.load()).toBeNull();
  });

  test("a tampered record does not load", async () => {
    const kv = memoryKv();
    const store = new PairingStore(kv);
    await store.save(generateStaticKeyPair(), {
      clientId: "c",
      desktopPublicKey: generateStaticKeyPair().publicKey,
    });
    const rec = (await kv.get<Record<string, unknown>>("pairing"))!;
    const other = generateStaticKeyPair();
    await kv.set("pairing", {
      ...rec,
      wrapped: { ...(rec["wrapped"] as object), publicKey: toBase64(other.publicKey) },
    });
    await expect(store.load()).rejects.toThrow();
  });
});
