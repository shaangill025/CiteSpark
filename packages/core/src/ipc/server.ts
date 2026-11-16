import { createServer, type Server, type Socket } from "node:net";
import {
  canonicalJson,
  ErrorCode,
  HandshakeFrameSchema,
  type Hello,
  type HelloReply,
  helloPrologue,
  IdempotencyLedger,
  negotiateVersion,
  PairClientMessageSchema,
  type PairClientMessage,
  type PairCoreMessage,
  parseHello,
  protocolError,
  ProtocolException,
  type ProtocolErrorBody,
  RecordFrameSchema,
  RequestSchema,
  type Scope,
  SUPPORTED_VERSIONS,
  type VersionRange,
} from "@citspark/protocol";
import {
  commitToNonce,
  fromBase64,
  Handshake,
  pairingCode,
  pairingNonce,
  SecureChannel,
  type StaticKeyPair,
  toBase64,
  type MessageTransport,
} from "@citspark/ipc";
import { socketTransport } from "@citspark/ipc/node";
import type { PairingController, PairingOutcome, PendingPairing } from "./pairing.ts";
import { prepareListenPath } from "./paths.ts";
import type { ClientRegistry, PairedClient } from "./registry.ts";

type Json = ReturnType<typeof JSON.parse>;

export interface RequestContext {
  readonly client: PairedClient;
  readonly requestId: string;
}

/** A core method. The server checks scope and the mutation flag before `handle` runs (ADR 0006). */
export interface MethodHandler {
  readonly scope: Scope;
  readonly mutation: boolean;
  handle(payload: Json, ctx: RequestContext): Promise<Json>;
}

export interface IpcServerOptions {
  /** The desktop's static key pair. Its storage (Electron safeStorage) arrives in M2. */
  staticKeyPair: StaticKeyPair;
  coreVersion: string;
  registry: ClientRegistry;
  pairing: PairingController;
  handlers?: Readonly<Record<string, MethodHandler>>;
  versions?: VersionRange;
  /** hello plus the Noise handshake must finish within this time. */
  handshakeTimeoutMs?: number;
  /** Called for unexpected handler failures; never receives message contents. */
  onInternalError?: (error: unknown) => void;
}

/**
 * The core's local socket server (ADR 0006, ADR 0011): a Unix socket or a Windows named pipe. Every
 * connection says hello, then runs Noise XX (pairing) or Noise IK (paired session). After the handshake
 * only encrypted records are accepted; anything else closes the connection without a reply.
 */
export class IpcServer {
  readonly #opts: IpcServerOptions;
  readonly #versions: VersionRange;
  readonly #connections = new Set<Connection>();
  readonly #byClient = new Map<string, Set<Connection>>();
  readonly #ledgers = new Map<string, IdempotencyLedger>();
  #server: Server | undefined;

  constructor(opts: IpcServerOptions) {
    this.#opts = opts;
    this.#versions = opts.versions ?? { ...SUPPORTED_VERSIONS };
  }

  async listen(path: string): Promise<void> {
    if (this.#server) throw new Error("already listening");
    await prepareListenPath(path);
    const server = createServer((socket) => this.#accept(socket));
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(path, () => {
        server.off("error", reject);
        resolve();
      });
    });
    this.#server = server;
  }

  async close(): Promise<void> {
    const server = this.#server;
    this.#server = undefined;
    for (const c of this.#connections) c.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  /** Removes the client's key and closes its open connections at once (ADR 0006). */
  revoke(clientId: string): boolean {
    const removed = this.#opts.registry.remove(clientId);
    for (const c of this.#byClient.get(clientId) ?? []) c.close();
    this.#byClient.delete(clientId);
    this.#ledgers.delete(clientId);
    return removed;
  }

  /** Serves one already-connected transport. Used by `listen`, and by tests with in-memory transports. */
  serve(transport: MessageTransport): Promise<void> {
    const conn = new Connection(transport);
    this.#connections.add(conn);
    return this.#run(conn).finally(() => {
      conn.close();
      this.#connections.delete(conn);
      if (conn.client) this.#byClient.get(conn.client.id)?.delete(conn);
    });
  }

  #accept(socket: Socket): void {
    socket.on("error", () => undefined);
    void this.serve(socketTransport(socket));
  }

  async #run(conn: Connection): Promise<void> {
    const timer = setTimeout(() => conn.close(), this.#opts.handshakeTimeoutMs ?? 10_000);
    let hello: Hello;
    let prologue: Uint8Array;
    try {
      const parsed = parseHello(await conn.transport.receive());
      if (!parsed.success) {
        conn.reject(protocolError(ErrorCode.InvalidMessage, "The first message must be hello."));
        return;
      }
      hello = parsed.data;
      if (hello.client.kind === "desktop-ui") {
        conn.reject(protocolError(ErrorCode.Unauthorized, "This client kind cannot connect here."));
        return;
      }
      const negotiated = negotiateVersion(hello.versions, this.#versions);
      if (!negotiated.ok) {
        conn.reject(negotiated.error);
        return;
      }
      conn.version = negotiated.version;
      const reply: HelloReply = {
        type: "hello.ok",
        version: negotiated.version,
        core: { version: this.#opts.coreVersion },
      };
      conn.transport.send(reply);
      prologue = helloPrologue(hello, reply);
      if (hello.channel === "session") {
        if (!(await this.#sessionHandshake(conn, hello, prologue))) return;
      } else {
        await this.#pairHandshake(conn, prologue);
      }
    } catch {
      return;
    } finally {
      clearTimeout(timer);
    }
    try {
      if (hello.channel === "session") await this.#dispatch(conn);
      else await this.#pair(conn, hello);
    } catch {
      // Channel or transport failure: the connection closes without a reply.
    }
  }

  async #sessionHandshake(conn: Connection, hello: Hello, prologue: Uint8Array): Promise<boolean> {
    const hs = new Handshake({
      pattern: "IK",
      initiator: false,
      staticKeyPair: this.#opts.staticKeyPair,
      prologue,
    });
    hs.readMessage(await conn.receiveHandshake());
    // IK message 1 authenticates the client's static key. Unknown or mismatched keys get no answer.
    const client = this.#opts.registry.findByPublicKey(hs.remoteStatic!);
    if (!client || client.kind !== hello.client.kind) return false;
    conn.transport.send({ type: "hs", d: toBase64(hs.writeMessage()) });
    conn.channel = new SecureChannel(hs.result());
    conn.client = client;
    let set = this.#byClient.get(client.id);
    if (!set) this.#byClient.set(client.id, (set = new Set()));
    set.add(conn);
    return true;
  }

  async #pairHandshake(conn: Connection, prologue: Uint8Array): Promise<void> {
    const hs = new Handshake({
      pattern: "XX",
      initiator: false,
      staticKeyPair: this.#opts.staticKeyPair,
      prologue,
    });
    while (!hs.complete) {
      if (hs.isMyTurn) conn.transport.send({ type: "hs", d: toBase64(hs.writeMessage()) });
      else hs.readMessage(await conn.receiveHandshake());
    }
    const keys = hs.result();
    conn.channel = new SecureChannel(keys, { maxMessageBytes: 4096 });
    conn.handshakeHash = keys.handshakeHash;
    conn.remoteStatic = keys.remoteStatic;
  }

  async #pair(conn: Connection, hello: Hello): Promise<void> {
    const { pairing, registry } = this.#opts;
    const fail = (e: ProtocolErrorBody) => {
      conn.sendSealed({ type: "pair.error", error: e } satisfies PairCoreMessage);
      conn.close();
    };
    const next = async (): Promise<PairClientMessage> => {
      const m = PairClientMessageSchema.safeParse(await conn.receiveSealed());
      if (!m.success) throw new Error("malformed pairing message");
      return m.data;
    };

    const req = await next();
    if (req.type !== "pair.request") return;
    if (registry.findByPublicKey(conn.remoteStatic!)) {
      fail(
        protocolError(
          ErrorCode.PairingFailed,
          "This client is already paired. Remove it in Citspark first.",
        ),
      );
      return;
    }
    let ended: (o: PairingOutcome) => void = () => undefined;
    const outcome = new Promise<PairingOutcome>((r) => (ended = r));
    let pending: PendingPairing;
    try {
      pending = pairing.begin({ clientKind: hello.client.kind, scopes: req.scopes, onEnd: ended });
    } catch (e) {
      if (e instanceof ProtocolException) fail(e.toBody());
      return;
    }
    try {
      const desktopNonce = pairingNonce();
      conn.sendSealed({
        type: "pair.commit",
        commit: toBase64(commitToNonce(conn.handshakeHash!, desktopNonce)),
      } satisfies PairCoreMessage);
      const nonceMsg = await next();
      if (nonceMsg.type !== "pair.nonce") return;
      const clientNonce = fromBase64(nonceMsg.nonce);
      conn.sendSealed({
        type: "pair.reveal",
        nonce: toBase64(desktopNonce),
      } satisfies PairCoreMessage);
      pending.open(pairingCode(conn.handshakeHash!, clientNonce, desktopNonce));

      // Anything the client sends now (pair.abort, junk, or closing) ends the pairing.
      void next().then(
        () => pending.abort(),
        () => pending.abort(),
      );
      const result = await outcome;
      if (result === "ok") {
        const client = registry.add({
          kind: hello.client.kind,
          publicKey: conn.remoteStatic!,
          scopes: req.scopes,
        });
        conn.sendSealed({
          type: "pair.ok",
          clientId: client.id,
          scopes: [...client.scopes],
        } satisfies PairCoreMessage);
      } else if (result === "locked") {
        fail(protocolError(ErrorCode.PairingLocked, "Too many wrong codes. Pairing is locked."));
      } else if (result === "expired") {
        fail(protocolError(ErrorCode.PairingExpired, "The pairing code expired. Start again."));
      } else if (result === "cancelled") {
        fail(protocolError(ErrorCode.PairingFailed, "Pairing was cancelled in Citspark."));
      }
    } finally {
      pending.abort();
    }
  }

  async #dispatch(conn: Connection): Promise<void> {
    const client = conn.client!;
    let ledger = this.#ledgers.get(client.id);
    if (!ledger) this.#ledgers.set(client.id, (ledger = new IdempotencyLedger()));
    for (;;) {
      const raw = await conn.receiveSealed();
      // Revocation may have raced with this frame; never act for a removed client.
      if (this.#opts.registry.get(client.id) !== client) return;
      const parsed = RequestSchema.safeParse(raw);
      if (!parsed.success) {
        const id = (raw as { id?: unknown } | null)?.id;
        if (typeof id !== "string" || id.length === 0 || id.length > 128) return;
        conn.respondError(id, protocolError(ErrorCode.InvalidMessage, "Malformed request."));
        continue;
      }
      void this.#handle(conn, ledger, parsed.data);
    }
  }

  async #handle(
    conn: Connection,
    ledger: IdempotencyLedger,
    req: { v: number; id: string; method: string; mutation: boolean; payload: Json },
  ): Promise<void> {
    const client = conn.client!;
    const handlers = this.#opts.handlers ?? {};
    const handler = Object.hasOwn(handlers, req.method) ? handlers[req.method] : undefined;
    if (req.v !== conn.version) {
      conn.respondError(req.id, protocolError(ErrorCode.Incompatible, "Wrong protocol version."));
      return;
    }
    if (!handler) {
      conn.respondError(req.id, protocolError(ErrorCode.NotFound, `Unknown method ${req.method}.`));
      return;
    }
    if (!client.scopes.includes(handler.scope)) {
      conn.respondError(
        req.id,
        protocolError(ErrorCode.Forbidden, `This client is not allowed to use ${req.method}.`),
      );
      return;
    }
    if (req.mutation !== handler.mutation) {
      conn.respondError(
        req.id,
        protocolError(ErrorCode.InvalidMessage, "The mutation flag does not match the method."),
      );
      return;
    }
    const ctx: RequestContext = { client, requestId: req.id };
    try {
      const result = handler.mutation
        ? await ledger.execute(req.id, canonicalJson([req.method, req.payload]), () =>
            handler.handle(req.payload, ctx),
          )
        : await handler.handle(req.payload, ctx);
      conn.respond(req.id, result);
    } catch (e) {
      if (e instanceof ProtocolException) {
        conn.respondError(req.id, e.toBody());
      } else {
        this.#opts.onInternalError?.(e);
        conn.respondError(
          req.id,
          protocolError(ErrorCode.Internal, "Citspark hit an internal error."),
        );
      }
    }
  }
}

class Connection {
  readonly transport: MessageTransport;
  version = 0;
  channel: SecureChannel | undefined;
  client: PairedClient | undefined;
  handshakeHash: Uint8Array | undefined;
  remoteStatic: Uint8Array | undefined;
  #closed = false;

  constructor(transport: MessageTransport) {
    this.transport = transport;
  }

  reject(error: ProtocolErrorBody): void {
    this.transport.send({ type: "hello.error", error } satisfies HelloReply);
    this.close();
  }

  async receiveHandshake(): Promise<Uint8Array> {
    const f = HandshakeFrameSchema.safeParse(await this.transport.receive());
    if (!f.success) throw new Error("expected a handshake frame");
    return fromBase64(f.data.d);
  }

  async receiveSealed(): Promise<unknown> {
    for (;;) {
      const f = RecordFrameSchema.safeParse(await this.transport.receive());
      if (!f.success) throw new Error("plaintext frame after handshake");
      const msg = this.channel!.open(f.data);
      if (msg !== undefined) return msg;
    }
  }

  sendSealed(message: unknown): void {
    if (this.#closed || !this.channel || this.channel.failed) return;
    for (const frame of this.channel.seal(message)) this.transport.send(frame);
  }

  respond(id: string, result: Json): void {
    this.sendSealed({ v: this.version, id, ok: true, result });
  }

  respondError(id: string, error: ProtocolErrorBody): void {
    this.sendSealed({ v: this.version, id, ok: false, error });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.transport.close();
  }
}
