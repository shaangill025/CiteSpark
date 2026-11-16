import * as sodium from "sodium-universal";
import { concatBytes, constantTimeEqual, randomBytes } from "./bytes.ts";

/**
 * Short authentication string for pairing (ADR 0011). A 6-digit code from the handshake hash alone lets a
 * man in the middle grind its own keys until both sides show the same code (about 10^6 tries). So the
 * desktop commits to a random nonce before it sees the client's nonce, as in Bluetooth numeric comparison
 * and ZRTP. The code then depends on a value the attacker cannot choose after the fact.
 */
export const PAIRING_NONCE_BYTES = 32;
const COMMIT_LABEL = new TextEncoder().encode("citspark/pair/commit/v1");
const CODE_LABEL = new TextEncoder().encode("citspark/pair/code/v1");
const DESKTOP_CODE_LABEL = new TextEncoder().encode("citspark/pair/desktop-code/v1");

function blake2b(outBytes: number, ...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(outBytes);
  sodium.crypto_generichash(out, concatBytes(...parts));
  return out;
}

function assertLengths(handshakeHash: Uint8Array, ...nonces: Uint8Array[]): void {
  if (handshakeHash.length !== 64) throw new Error("handshake hash must be 64 bytes");
  for (const n of nonces) {
    if (n.length !== PAIRING_NONCE_BYTES) throw new Error("pairing nonce must be 32 bytes");
  }
}

export function pairingNonce(): Uint8Array {
  return randomBytes(PAIRING_NONCE_BYTES);
}

export function commitToNonce(handshakeHash: Uint8Array, nonce: Uint8Array): Uint8Array {
  assertLengths(handshakeHash, nonce);
  return blake2b(32, COMMIT_LABEL, handshakeHash, nonce);
}

export function verifyNonceCommitment(
  handshakeHash: Uint8Array,
  nonce: Uint8Array,
  commitment: Uint8Array,
): boolean {
  return constantTimeEqual(commitToNonce(handshakeHash, nonce), commitment);
}

function sixDigits(
  label: Uint8Array,
  handshakeHash: Uint8Array,
  clientNonce: Uint8Array,
  desktopNonce: Uint8Array,
): string {
  assertLengths(handshakeHash, clientNonce, desktopNonce);
  const digest = blake2b(32, label, handshakeHash, clientNonce, desktopNonce);
  let n = 0n;
  for (const b of digest.subarray(0, 8)) n = (n << 8n) | BigInt(b);
  // 2^64 mod 10^6 bias is below 2^-44.
  return (n % 1_000_000n).toString().padStart(6, "0");
}

/** The code the client shows and the user types into the desktop. Proves a person approved the client. */
export function pairingCode(
  handshakeHash: Uint8Array,
  clientNonce: Uint8Array,
  desktopNonce: Uint8Array,
): string {
  return sixDigits(CODE_LABEL, handshakeHash, clientNonce, desktopNonce);
}

/**
 * The code the desktop shows once it accepted the client's code, and the user types into the client. Proves
 * to the client that the peer it paired with is the Citspark the person is looking at, not a process that
 * took the socket or pipe name. Independent of `pairingCode`, so knowing one does not reveal the other.
 */
export function desktopCode(
  handshakeHash: Uint8Array,
  clientNonce: Uint8Array,
  desktopNonce: Uint8Array,
): string {
  return sixDigits(DESKTOP_CODE_LABEL, handshakeHash, clientNonce, desktopNonce);
}
