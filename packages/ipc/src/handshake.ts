import Noise from "noise-handshake";
import type { StaticKeyPair } from "./keys.ts";
import { PUBLIC_KEY_BYTES } from "./keys.ts";

/**
 * XX for first pairing, IK for every later connection (ADR 0011 supersedes KK from ADR 0006 because the
 * maintained library has no KK). Protocol name: Noise_{XX,IK}_25519_ChaChaPoly_BLAKE2b.
 */
export type HandshakePattern = "XX" | "IK";

export class HandshakeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "HandshakeError";
  }
}

export interface HandshakeResult {
  readonly tx: Uint8Array;
  readonly rx: Uint8Array;
  readonly handshakeHash: Uint8Array;
  readonly remoteStatic: Uint8Array;
}

const MESSAGE_COUNT: Record<HandshakePattern, number> = { XX: 3, IK: 2 };

/** Thin turn-enforcing wrapper: the library itself does not check whose turn it is. */
export class Handshake {
  readonly #noise: Noise;
  readonly #initiator: boolean;
  readonly #total: number;
  #index = 0;
  #failed = false;

  constructor(opts: {
    pattern: HandshakePattern;
    initiator: boolean;
    staticKeyPair: StaticKeyPair;
    prologue: Uint8Array;
    remoteStatic?: Uint8Array;
  }) {
    const needsRemote = opts.pattern === "IK" && opts.initiator;
    if (needsRemote !== (opts.remoteStatic !== undefined)) {
      throw new HandshakeError("IK initiator needs the remote static key; nothing else may set it");
    }
    if (opts.remoteStatic && opts.remoteStatic.length !== PUBLIC_KEY_BYTES) {
      throw new HandshakeError("remote static key must be 32 bytes");
    }
    this.#noise = new Noise(opts.pattern, opts.initiator, {
      publicKey: opts.staticKeyPair.publicKey,
      secretKey: opts.staticKeyPair.secretKey,
    });
    this.#noise.initialise(opts.prologue, opts.remoteStatic);
    this.#initiator = opts.initiator;
    this.#total = MESSAGE_COUNT[opts.pattern];
  }

  get complete(): boolean {
    return this.#noise.complete;
  }

  get isMyTurn(): boolean {
    return !this.complete && !this.#failed && this.#index % 2 === (this.#initiator ? 0 : 1);
  }

  /** The peer's static key once the handshake has revealed it (IK responder: after message 1). */
  get remoteStatic(): Uint8Array | undefined {
    return this.#noise.rs ? new Uint8Array(this.#noise.rs) : undefined;
  }

  writeMessage(): Uint8Array {
    if (!this.isMyTurn) throw new HandshakeError("not our turn to send");
    try {
      const msg = this.#noise.send();
      this.#index++;
      return msg;
    } catch (e) {
      this.#failed = true;
      throw new HandshakeError("handshake send failed", { cause: e });
    }
  }

  readMessage(message: Uint8Array): void {
    if (this.complete || this.#failed || this.isMyTurn) {
      this.#failed = true;
      throw new HandshakeError("unexpected handshake message");
    }
    let payload: Uint8Array;
    try {
      payload = this.#noise.recv(message);
    } catch (e) {
      this.#failed = true;
      throw new HandshakeError("handshake message rejected", { cause: e });
    }
    this.#index++;
    // We never send handshake payloads, so anything here is an attacker's attempt to smuggle data.
    if (payload.length !== 0) {
      this.#failed = true;
      throw new HandshakeError("unexpected handshake payload");
    }
  }

  result(): HandshakeResult {
    const n = this.#noise;
    if (!n.complete || this.#index !== this.#total || !n.tx || !n.rx || !n.hash || !n.rs) {
      throw new HandshakeError("handshake not complete");
    }
    return {
      tx: new Uint8Array(n.tx),
      rx: new Uint8Array(n.rx),
      handshakeHash: new Uint8Array(n.hash),
      remoteStatic: new Uint8Array(n.rs),
    };
  }
}
