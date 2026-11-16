import { randomUUID, timingSafeEqual } from "node:crypto";
import { type Hello, IdempotencyLedger, type Scope } from "@citspark/protocol";

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
  /**
   * The client's replay ledger (§14). It lives exactly as long as the client's registration, never as long
   * as a connection or a server instance: a retry after reconnecting or restarting the listener must find
   * the stored outcome. A durable registry (M2) must persist it alongside the key. Undefined once removed.
   */
  ledger(id: string): IdempotencyLedger | undefined;
  /** Revocation deletes the public key and the ledger, so the client can never complete a handshake again. */
  remove(id: string): boolean;
  list(): PairedClient[];
}

/** In-process registry. Durable storage arrives with the store and the Electron shell (M2-01, M2-03). */
export class MemoryClientRegistry implements ClientRegistry {
  readonly #clients = new Map<string, PairedClient>();
  readonly #ledgers = new Map<string, IdempotencyLedger>();
  readonly #now: () => Date;
  readonly #ledgerCapacity: number | undefined;

  constructor(opts: { now?: () => Date; ledgerCapacity?: number } = {}) {
    this.#now = opts.now ?? (() => new Date());
    this.#ledgerCapacity = opts.ledgerCapacity;
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

  ledger(id: string): IdempotencyLedger | undefined {
    if (!this.#clients.has(id)) return undefined;
    let ledger = this.#ledgers.get(id);
    if (!ledger) {
      ledger = new IdempotencyLedger(
        this.#ledgerCapacity === undefined ? {} : { capacity: this.#ledgerCapacity },
      );
      this.#ledgers.set(id, ledger);
    }
    return ledger;
  }

  remove(id: string): boolean {
    this.#ledgers.delete(id);
    return this.#clients.delete(id);
  }

  list(): PairedClient[] {
    return [...this.#clients.values()];
  }
}
