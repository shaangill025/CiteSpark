import {
  ClientSession,
  connectSession,
  generateStaticKeyPair,
  HelloRejectedError,
  MessageQueue,
  pairWithDesktop,
  RequestError,
  TransportClosedError,
  type ClientIdentity,
  type MessageTransport,
} from "@citspark/ipc";
import { Scope } from "@citspark/protocol";
import type { PairingStore } from "./keystore.ts";

/** The subset of `chrome.runtime.Port` the link uses; a fake in tests. */
export interface PortLike {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
  disconnect(): void;
}

/** What the popup shows when capture cannot reach the desktop (ADR 0006, M1-08). */
export type LinkState =
  | "not_paired"
  | "host_missing"
  | "desktop_unavailable"
  | "incompatible"
  | "pairing_invalid"
  | "ready";

export class LinkError extends Error {
  readonly state: LinkState;
  constructor(state: LinkState, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LinkError";
    this.state = state;
  }
}

/** Native messaging port as a MessageTransport. Counts inbound messages to tell "no desktop" apart. */
export function portTransport(
  port: PortLike,
  lastError: () => string | undefined,
): MessageTransport & { readonly received: number } {
  const queue = new MessageQueue();
  let received = 0;
  let closed = false;
  port.onMessage.addListener((m) => {
    received++;
    queue.push(m);
  });
  port.onDisconnect.addListener(() => {
    closed = true;
    queue.close(new TransportClosedError(lastError() ?? "native host disconnected"));
  });
  return {
    get received() {
      return received;
    },
    send(message) {
      if (closed) throw new TransportClosedError("native host disconnected");
      port.postMessage(message);
    },
    receive: () => queue.next(),
    close() {
      if (closed) return;
      closed = true;
      queue.close();
      try {
        port.disconnect();
      } catch {
        // already gone
      }
    },
  };
}

function classify(e: unknown, t: { received: number }, lastError: string | undefined): LinkError {
  if (e instanceof HelloRejectedError)
    return new LinkError("incompatible", e.message, { cause: e });
  if (t.received === 0) {
    if (lastError && /not found|forbidden/i.test(lastError)) {
      return new LinkError(
        "host_missing",
        "The Citspark native host is not installed for this browser.",
        { cause: e },
      );
    }
    return new LinkError("desktop_unavailable", "Citspark is not running on this computer.", {
      cause: e,
    });
  }
  return new LinkError(
    "pairing_invalid",
    "Citspark did not accept this extension. Pair it again from the extension.",
    { cause: e },
  );
}

export interface PairingUi {
  showCode(code: string): void;
  enterDesktopCode(signal: AbortSignal): Promise<string>;
  signal?: AbortSignal;
}

/**
 * The extension's connection to the desktop over native messaging (ADR 0006, ADR 0011). Every
 * session runs Noise IK against the pinned desktop key; the host relays ciphertext only. Mutations
 * carry a caller-chosen request ID and are retried once after a lost connection with the same ID, so
 * the desktop's idempotency ledger answers instead of running them twice (§14).
 */
export class DesktopLink {
  readonly #o: LinkOptions;
  #session: ClientSession | undefined;
  #connecting: Promise<ClientSession> | undefined;

  constructor(o: LinkOptions) {
    this.#o = o;
  }

  async check(): Promise<LinkState> {
    try {
      await this.session();
      return "ready";
    } catch (e) {
      return e instanceof LinkError ? e.state : "desktop_unavailable";
    }
  }

  session(): Promise<ClientSession> {
    if (this.#session) return Promise.resolve(this.#session);
    this.#connecting ??= this.#connect().finally(() => (this.#connecting = undefined));
    return this.#connecting;
  }

  async #connect(): Promise<ClientSession> {
    const pairing = await this.#o.store.load().catch((e: unknown) => {
      throw new LinkError("pairing_invalid", "The stored pairing could not be read.", { cause: e });
    });
    if (!pairing) throw new LinkError("not_paired", "Pair this extension with Citspark first.");
    const t = portTransport(this.#o.openPort(), this.#o.lastError);
    try {
      const s = await connectSession({
        transport: t,
        identity: this.#identity(pairing.keyPair),
        desktopPublicKey: pairing.desktopPublicKey,
      });
      this.#session = s;
      void s.closed.then(() => {
        if (this.#session !== s) return;
        this.#session = undefined;
        // Tell the owner, so a "ready" shown to the user never outlives the connection.
        this.#o.onSessionClosed?.();
      });
      return s;
    } catch (e) {
      throw classify(e, t, this.#o.lastError());
    } finally {
      // The raw key is needed only for the handshake (ADR 0011).
      pairing.keyPair.secretKey.fill(0);
    }
  }

  async request(method: string, payload: unknown, id: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      const s = await this.session();
      try {
        return await s.request(method, payload, { mutation: true, id });
      } catch (e) {
        if (e instanceof RequestError || attempt >= 1) throw e;
        if (this.#session === s) this.#session = undefined;
      }
    }
  }

  async pair(ui: PairingUi): Promise<void> {
    this.close();
    const keyPair = generateStaticKeyPair();
    const t = portTransport(this.#o.openPort(), this.#o.lastError);
    try {
      const r = await pairWithDesktop({
        transport: t,
        identity: this.#identity(keyPair),
        scopes: [Scope.CaptureWrite],
        showCode: ui.showCode,
        enterDesktopCode: ui.enterDesktopCode,
        ...(ui.signal ? { signal: ui.signal } : {}),
      });
      await this.#o.store.save(keyPair, {
        clientId: r.clientId,
        desktopPublicKey: r.desktopPublicKey,
      });
    } catch (e) {
      if (e instanceof Error && e.name !== "TransportClosedError") throw e;
      throw classify(e, t, this.#o.lastError());
    } finally {
      keyPair.secretKey.fill(0);
    }
  }

  close(): void {
    this.#session?.close();
    this.#session = undefined;
  }

  #identity(staticKeyPair: ClientIdentity["staticKeyPair"]): ClientIdentity {
    return { kind: "extension", version: this.#o.version, staticKeyPair };
  }
}

export interface LinkOptions {
  openPort: () => PortLike;
  lastError: () => string | undefined;
  store: PairingStore;
  version: string;
  /** Called when an established session drops (desktop quit, host exited). Not on `close()`. */
  onSessionClosed?: () => void;
}
