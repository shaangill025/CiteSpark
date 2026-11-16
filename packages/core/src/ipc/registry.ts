import { randomUUID, timingSafeEqual } from "node:crypto";
import type { Hello, Scope } from "@citspark/protocol";

export type ClientKind = Hello["client"]["kind"];

/** What the desktop keeps per paired client (ADR 0006): public key and grants only, never a shared secret. */
export interface PairedClient {
  readonly id: string;
  readonly kind: ClientKind;
  readonly publicKey: Uint8Array;
  readonly scopes: readonly Scope[];
  readonly createdAt: string;
}

export interface ClientRegistry {
  findByPublicKey(publicKey: Uint8Array): PairedClient | undefined;
  get(id: string): PairedClient | undefined;
  add(client: Pick<PairedClient, "kind" | "publicKey" | "scopes">): PairedClient;
  /** Revocation deletes the public key, so the client can never complete a handshake again. */
  remove(id: string): boolean;
  list(): PairedClient[];
}

/** In-process registry. Durable storage arrives with the store and the Electron shell (M2-01, M2-03). */
export class MemoryClientRegistry implements ClientRegistry {
  readonly #clients = new Map<string, PairedClient>();
  readonly #now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.#now = opts.now ?? (() => new Date());
  }

  findByPublicKey(publicKey: Uint8Array): PairedClient | undefined {
    for (const c of this.#clients.values()) {
      if (c.publicKey.length === publicKey.length && timingSafeEqual(c.publicKey, publicKey)) {
        return c;
      }
    }
    return undefined;
  }

  get(id: string): PairedClient | undefined {
    return this.#clients.get(id);
  }

  add(client: Pick<PairedClient, "kind" | "publicKey" | "scopes">): PairedClient {
    const record: PairedClient = Object.freeze({
      id: randomUUID(),
      kind: client.kind,
      publicKey: new Uint8Array(client.publicKey),
      scopes: Object.freeze([...client.scopes]),
      createdAt: this.#now().toISOString(),
    });
    this.#clients.set(record.id, record);
    return record;
  }

  remove(id: string): boolean {
    return this.#clients.delete(id);
  }

  list(): PairedClient[] {
    return [...this.#clients.values()];
  }
}
