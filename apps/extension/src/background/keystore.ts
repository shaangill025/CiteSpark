import {
  fromBase64,
  generateWrappingKey,
  toBase64,
  unwrapStaticKey,
  wrapStaticKey,
  type StaticKeyPair,
  type WrappedStaticKey,
} from "@citspark/ipc";
import type { Kv } from "./pacer.ts";

interface PairingRecord {
  v: 1;
  /** Non-extractable AES-GCM key; IndexedDB keeps the CryptoKey object, never its bytes. */
  wrappingKey: CryptoKey;
  wrapped: WrappedStaticKey;
  clientId: string;
  /** Pinned desktop static public key (not a secret). */
  desktopPublicKey: string;
}

export interface Pairing {
  keyPair: StaticKeyPair;
  clientId: string;
  desktopPublicKey: Uint8Array;
}

/**
 * The extension's pairing state (ADR 0011): the client's X25519 key wrapped by a non-extractable
 * WebCrypto AES-GCM key, plus the pinned desktop key. No shared secret and no X credential is ever
 * stored (SEC-04). The raw key exists in memory only while a handshake runs.
 */
export class PairingStore {
  readonly #kv: Kv;

  constructor(kv: Kv) {
    this.#kv = kv;
  }

  async save(
    keyPair: StaticKeyPair,
    p: { clientId: string; desktopPublicKey: Uint8Array },
  ): Promise<void> {
    const wrappingKey = await generateWrappingKey();
    const record: PairingRecord = {
      v: 1,
      wrappingKey,
      wrapped: await wrapStaticKey(keyPair, wrappingKey),
      clientId: p.clientId,
      desktopPublicKey: toBase64(p.desktopPublicKey),
    };
    await this.#kv.set("pairing", record);
  }

  /** Null when unpaired. Throws when the stored record does not unwrap (tampered or corrupted). */
  async load(): Promise<Pairing | null> {
    const r = await this.#kv.get<PairingRecord>("pairing");
    if (!r || r.v !== 1) return null;
    return {
      keyPair: await unwrapStaticKey(r.wrapped, r.wrappingKey),
      clientId: r.clientId,
      desktopPublicKey: fromBase64(r.desktopPublicKey),
    };
  }

  async paired(): Promise<boolean> {
    return (await this.#kv.get<PairingRecord>("pairing"))?.v === 1;
  }

  async clear(): Promise<void> {
    await this.#kv.set("pairing", null);
  }
}
