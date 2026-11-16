import {
  ErrorCode,
  HandshakeFrameSchema,
  type Hello,
  HelloReplySchema,
  helloPrologue,
  PairCoreMessageSchema,
  type PairCoreMessage,
  type ProtocolErrorBody,
  type RecordFrame,
  RecordFrameSchema,
  ResponseSchema,
  type Scope,
  SUPPORTED_VERSIONS,
  type VersionRange,
} from "@citspark/protocol";
import { constantTimeEqual, fromBase64, toBase64 } from "./bytes.ts";
import { Handshake, HandshakeError, type HandshakeResult } from "./handshake.ts";
import type { StaticKeyPair } from "./keys.ts";
import { ChannelError, SecureChannel } from "./records.ts";
import { desktopCode, pairingCode, pairingNonce, verifyNonceCommitment } from "./sas.ts";
import { type MessageTransport, TransportClosedError } from "./transport.ts";

export interface ClientIdentity {
  kind: Hello["client"]["kind"];
  version: string;
  staticKeyPair: StaticKeyPair;
  versions?: VersionRange;
}

/** The core answered `hello` with a structured error, e.g. `incompatible`. Show `error.message` (PLG-02). */
export class HelloRejectedError extends Error {
  readonly error: ProtocolErrorBody;
  constructor(error: ProtocolErrorBody) {
    super(error.message);
    this.name = "HelloRejectedError";
    this.error = error;
  }
}

export class PairingError extends Error {
  readonly error: ProtocolErrorBody;
  constructor(error: ProtocolErrorBody) {
    super(error.message);
    this.name = "PairingError";
    this.error = error;
  }
}

export class RequestError extends Error {
  readonly error: ProtocolErrorBody;
  constructor(error: ProtocolErrorBody) {
    super(error.message);
    this.name = "RequestError";
    this.error = error;
  }
}

async function sayHello(
  transport: MessageTransport,
  identity: ClientIdentity,
  channel: Hello["channel"],
): Promise<{ prologue: Uint8Array; version: number }> {
  const hello: Hello = {
    type: "hello",
    versions: identity.versions ?? { ...SUPPORTED_VERSIONS },
    client: { kind: identity.kind, version: identity.version },
    channel,
  };
  transport.send(hello);
  const parsed = HelloReplySchema.safeParse(await transport.receive());
  if (!parsed.success) throw new HandshakeError("malformed hello reply");
  const reply = parsed.data;
  if (reply.type === "hello.error") throw new HelloRejectedError(reply.error);
  if (reply.version < hello.versions.min || reply.version > hello.versions.max) {
    throw new HandshakeError("core chose a version outside our range");
  }
  return { prologue: helloPrologue(hello, reply), version: reply.version };
}

async function runInitiator(transport: MessageTransport, hs: Handshake): Promise<HandshakeResult> {
  while (!hs.complete) {
    if (hs.isMyTurn) {
      transport.send({ type: "hs", d: toBase64(hs.writeMessage()) });
    } else {
      const f = HandshakeFrameSchema.safeParse(await transport.receive());
      if (!f.success) throw new HandshakeError("expected a handshake frame");
      hs.readMessage(fromBase64(f.data.d));
    }
  }
  return hs.result();
}

async function receiveSealed(
  transport: MessageTransport,
  channel: SecureChannel,
): Promise<unknown> {
  for (;;) {
    const f = RecordFrameSchema.safeParse(await transport.receive());
    if (!f.success) throw new ChannelError("plaintext frame after handshake");
    const msg = channel.open(f.data);
    if (msg !== undefined) return msg;
  }
}

function send(transport: MessageTransport, channel: SecureChannel, message: unknown): void {
  for (const frame of channel.seal(message)) transport.send(frame);
}

export interface PairingResult {
  clientId: string;
  scopes: Scope[];
  /** Pin this; every later connection runs IK against it. Not a secret. */
  desktopPublicKey: Uint8Array;
}

/**
 * First pairing over Noise XX (ADR 0011). After the handshake and the nonce commitment, `showCode` displays
 * the 6-digit code; the user types it into the Citspark pairing dialog. The desktop accepts only if the code
 * typed there equals its own, which proves that a person approved this client and that nobody sits in the
 * middle (a relay would produce different codes on the two sides).
 *
 * The desktop then shows a second code, and `enterDesktopCode` asks the user to type it here. The client
 * pins the desktop key only if that code matches, which proves the peer is the Citspark the person is looking
 * at and not a process that took the socket or pipe name (it can say `pair.ok`, but cannot put a code in the
 * real Citspark window). `enterDesktopCode` receives a signal that aborts when the pairing ends first.
 * Abort with `signal`. Always closes the transport.
 */
export async function pairWithDesktop(opts: {
  transport: MessageTransport;
  identity: ClientIdentity;
  scopes: Scope[];
  showCode: (code: string) => void;
  enterDesktopCode: (signal: AbortSignal) => Promise<string>;
  signal?: AbortSignal;
}): Promise<PairingResult> {
  const { transport, signal } = opts;
  let channel: SecureChannel | undefined;
  const onAbort = () => {
    if (channel && !channel.failed) send(transport, channel, { type: "pair.abort" });
    transport.close();
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  const prompt = new AbortController();
  try {
    signal?.throwIfAborted();
    const { prologue } = await sayHello(transport, opts.identity, "pair");
    const keys = await runInitiator(
      transport,
      new Handshake({
        pattern: "XX",
        initiator: true,
        staticKeyPair: opts.identity.staticKeyPair,
        prologue,
      }),
    );
    channel = new SecureChannel(keys);
    const ch = channel;
    const next = async <T extends PairCoreMessage["type"]>(type: T) => {
      const m = PairCoreMessageSchema.safeParse(await receiveSealed(transport, ch));
      if (!m.success) throw new ChannelError("malformed pairing message");
      if (m.data.type === "pair.error") throw new PairingError(m.data.error);
      if (m.data.type !== type) throw new ChannelError(`expected ${type}, got ${m.data.type}`);
      return m.data as Extract<PairCoreMessage, { type: T }>;
    };

    send(transport, ch, { type: "pair.request", scopes: opts.scopes });
    const commit = fromBase64((await next("pair.commit")).commit);
    const clientNonce = pairingNonce();
    send(transport, ch, { type: "pair.nonce", nonce: toBase64(clientNonce) });
    const desktopNonce = fromBase64((await next("pair.reveal")).nonce);
    if (!verifyNonceCommitment(keys.handshakeHash, desktopNonce, commit)) {
      send(transport, ch, { type: "pair.abort" });
      throw new PairingError({
        code: ErrorCode.PairingFailed,
        message: "The desktop broke its pairing commitment. Pairing stopped.",
      });
    }
    opts.showCode(pairingCode(keys.handshakeHash, clientNonce, desktopNonce));
    await next("pair.approved");
    // pair.ok must not arrive before we accept; an early one (or pair.error, or a close) ends the prompt.
    const final = next("pair.ok");
    final.catch(() => undefined);
    const early = final.then(() => {
      throw new ChannelError("the desktop claimed success before its code was confirmed");
    });
    early.catch(() => undefined);
    const typed = await Promise.race([
      Promise.resolve().then(() => opts.enterDesktopCode(prompt.signal)),
      early,
    ]);
    signal?.throwIfAborted();
    const expected = desktopCode(keys.handshakeHash, clientNonce, desktopNonce);
    const enc = new TextEncoder();
    if (!constantTimeEqual(enc.encode(String(typed).trim()), enc.encode(expected))) {
      send(transport, ch, { type: "pair.abort" });
      throw new PairingError({
        code: ErrorCode.PairingFailed,
        message: "That is not the code Citspark shows. Pairing stopped; start again.",
      });
    }
    send(transport, ch, { type: "pair.accept" });
    const ok = await final;
    return { clientId: ok.clientId, scopes: ok.scopes, desktopPublicKey: keys.remoteStatic };
  } catch (e) {
    if (signal?.aborted) throw signal.reason;
    throw e;
  } finally {
    prompt.abort();
    signal?.removeEventListener("abort", onAbort);
    transport.close();
  }
}

type Pending = { resolve: (v: unknown) => void; reject: (e: unknown) => void };

/** An authenticated, encrypted connection to the core (Noise IK against the pinned desktop key). */
export class ClientSession {
  readonly version: number;
  readonly #transport: MessageTransport;
  readonly #channel: SecureChannel;
  readonly #pending = new Map<string, Pending>();
  #closed: Error | undefined;
  readonly closed: Promise<Error>;

  constructor(transport: MessageTransport, channel: SecureChannel, version: number) {
    this.#transport = transport;
    this.#channel = channel;
    this.version = version;
    this.closed = this.#readLoop();
  }

  request(
    method: string,
    payload: unknown,
    opts: { mutation?: boolean; id?: string } = {},
  ): Promise<unknown> {
    if (this.#closed) return Promise.reject(this.#closed);
    const id = opts.id ?? crypto.randomUUID();
    if (this.#pending.has(id)) return Promise.reject(new Error("request ID already in flight"));
    let frames: RecordFrame[];
    try {
      // Sealing serialises and size-checks before it encrypts; a refused message leaves the channel as it was.
      frames = this.#channel.seal({
        v: this.version,
        id,
        method,
        mutation: opts.mutation ?? false,
        payload,
      });
    } catch (e) {
      if (this.#channel.failed) this.#shutdown(e instanceof Error ? e : new Error(String(e)));
      return Promise.reject(e instanceof Error ? e : new Error(String(e)));
    }
    const p = new Promise<unknown>((resolve, reject) => this.#pending.set(id, { resolve, reject }));
    try {
      for (const frame of frames) this.#transport.send(frame);
    } catch (e) {
      // Some records may be out: the peer's receive counter no longer matches ours.
      this.#shutdown(e instanceof Error ? e : new Error(String(e)));
    }
    return p;
  }

  close(): void {
    this.#shutdown(new TransportClosedError("closed by client"));
  }

  async #readLoop(): Promise<Error> {
    try {
      for (;;) {
        const r = ResponseSchema.safeParse(await receiveSealed(this.#transport, this.#channel));
        if (!r.success) throw new ChannelError("malformed response");
        const p = this.#pending.get(r.data.id);
        if (!p) continue;
        this.#pending.delete(r.data.id);
        if (r.data.ok) p.resolve(r.data.result);
        else p.reject(new RequestError(r.data.error));
      }
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.#shutdown(err);
      return err;
    }
  }

  #shutdown(err: Error): void {
    if (this.#closed) return;
    this.#closed = err;
    this.#transport.close();
    for (const p of this.#pending.values()) p.reject(err);
    this.#pending.clear();
  }
}

export async function connectSession(opts: {
  transport: MessageTransport;
  identity: ClientIdentity;
  desktopPublicKey: Uint8Array;
}): Promise<ClientSession> {
  const { transport } = opts;
  try {
    const { prologue, version } = await sayHello(transport, opts.identity, "session");
    const keys = await runInitiator(
      transport,
      new Handshake({
        pattern: "IK",
        initiator: true,
        staticKeyPair: opts.identity.staticKeyPair,
        prologue,
        remoteStatic: opts.desktopPublicKey,
      }),
    );
    return new ClientSession(transport, new SecureChannel(keys), version);
  } catch (e) {
    transport.close();
    throw e;
  }
}
