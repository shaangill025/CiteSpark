import * as dh from "noise-handshake/dh.js";
import { concatBytes, constantTimeEqual, fromBase64, toBase64 } from "./bytes.ts";

/** An X25519 static key pair (ADR 0006). The secret key never leaves the process that created it. */
export interface StaticKeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

export const PUBLIC_KEY_BYTES = 32;

function plain(kp: StaticKeyPair): StaticKeyPair {
  return { publicKey: new Uint8Array(kp.publicKey), secretKey: new Uint8Array(kp.secretKey) };
}

export function generateStaticKeyPair(): StaticKeyPair {
  return plain(dh.generateKeyPair());
}

/** At-rest form of a client static key (ADR 0011): sealed by a non-extractable WebCrypto AES-GCM key. */
export interface WrappedStaticKey {
  readonly v: 1;
  readonly publicKey: string;
  readonly iv: string;
  readonly sealed: string;
}

const WRAP_LABEL = new TextEncoder().encode("citspark/client-static-key/v1");

/** Non-extractable, so its raw bytes cannot be read back from IndexedDB or exported by script. */
export function generateWrappingKey(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function wrapStaticKey(
  keyPair: StaticKeyPair,
  wrappingKey: CryptoKey,
): Promise<WrappedStaticKey> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: concatBytes(WRAP_LABEL, keyPair.publicKey) },
    wrappingKey,
    concatBytes(keyPair.secretKey),
  );
  return {
    v: 1,
    publicKey: toBase64(keyPair.publicKey),
    iv: toBase64(iv),
    sealed: toBase64(new Uint8Array(sealed)),
  };
}

export async function unwrapStaticKey(
  wrapped: WrappedStaticKey,
  wrappingKey: CryptoKey,
): Promise<StaticKeyPair> {
  const publicKey = fromBase64(wrapped.publicKey);
  const secret = new Uint8Array(
    await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(wrapped.iv),
        additionalData: concatBytes(WRAP_LABEL, publicKey),
      },
      wrappingKey,
      fromBase64(wrapped.sealed),
    ),
  );
  const keyPair = dh.generateKeyPair(secret);
  if (!constantTimeEqual(keyPair.publicKey, publicKey)) {
    throw new Error("unwrapped key does not match its public key");
  }
  return plain(keyPair);
}
