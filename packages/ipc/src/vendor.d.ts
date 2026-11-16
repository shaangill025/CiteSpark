// Minimal typings for the untyped CommonJS crypto dependencies (ADR 0011). Kept internal to @citspark/ipc.

declare module "noise-handshake" {
  export interface KeyPair {
    publicKey: Uint8Array;
    secretKey: Uint8Array;
  }
  export default class NoiseState {
    constructor(pattern: "XX" | "IK", initiator: boolean, staticKeyPair?: KeyPair);
    initialise(prologue: Uint8Array, remoteStatic?: Uint8Array): void;
    send(payload?: Uint8Array): Uint8Array;
    recv(message: Uint8Array): Uint8Array;
    complete: boolean;
    rs: Uint8Array | null;
    tx: Uint8Array | null;
    rx: Uint8Array | null;
    hash: Uint8Array | null;
  }
}

declare module "noise-handshake/cipher.js" {
  export default class CipherState {
    constructor(key?: Uint8Array);
    nonce: number;
    encrypt(plaintext: Uint8Array, ad?: Uint8Array): Uint8Array;
    decrypt(ciphertext: Uint8Array, ad?: Uint8Array): Uint8Array;
  }
}

declare module "noise-handshake/dh.js" {
  import type { KeyPair } from "noise-handshake";
  export const PKLEN: number;
  export const SKLEN: number;
  export function generateKeyPair(secretKey?: Uint8Array): KeyPair;
}

declare module "sodium-universal" {
  export function crypto_generichash(out: Uint8Array, input: Uint8Array, key?: Uint8Array): void;
  export function randombytes_buf(out: Uint8Array): void;
  export function sodium_memcmp(a: Uint8Array, b: Uint8Array): boolean;
  export function sodium_memzero(b: Uint8Array): void;
}
