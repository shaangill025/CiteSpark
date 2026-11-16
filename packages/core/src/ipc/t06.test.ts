// T06 (pairing and local IPC security) against a real Unix socket or Windows named pipe. Synthetic data only.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, test } from "vitest";
import {
  ErrorCode,
  encodeFrame,
  FrameDecoder,
  type Hello,
  type Scope,
  Scope as S,
  helloPrologue,
  type HelloReply,
} from "@citspark/protocol";
import {
  type ClientIdentity,
  commitToNonce,
  connectSession,
  generateStaticKeyPair,
  Handshake,
  HelloRejectedError,
  MessageQueue,
  type MessageTransport,
  pairingNonce,
  PairingError,
  pairWithDesktop,
  RequestError,
  SecureChannel,
  toBase64,
  fromBase64,
  TransportClosedError,
  type PairingResult,
} from "@citspark/ipc";
import { connectIpc, socketTransport } from "@citspark/ipc/node";
import { IpcServer, type MethodHandler } from "./server.ts";
import { MemoryClientRegistry } from "./registry.ts";
import { PairingController, type PairingDialog, type PairingPrompt } from "./pairing.ts";
import { prepareListenPath } from "./paths.ts";

const isWin = process.platform === "win32";
const MARKER = "SYNTHETIC-T06-MARKER-7f3a";
let dir = "";
const cleanups: (() => Promise<void> | void)[] = [];

beforeAll(async () => {
  if (!isWin) dir = await mkdtemp(join(tmpdir(), "cs-"));
});
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});
afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

function endpoint(): string {
  const tag = randomUUID().slice(0, 8);
  return isWin ? `\\\\.\\pipe\\citspark-t06-${process.pid}-${tag}` : join(dir, tag, "core.sock");
}

/**
 * Runs a child process with a hard deadline. On failure the error carries the elapsed time and
 * everything the child printed, so a CI log shows the last stage it reached instead of a bare
 * Vitest timeout.
 */
function runBounded(
  file: string,
  args: readonly string[],
  opts: { deadlineMs: number; env?: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string; elapsedMs: number }> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: opts.deadlineMs, killSignal: "SIGKILL", env: opts.env ?? process.env },
      (err, stdout, stderr) => {
        const elapsedMs = Date.now() - started;
        if (!err) return resolve({ stdout, stderr, elapsedMs });
        const why = err.killed
          ? `timed out after ${opts.deadlineMs}ms`
          : `exited with code ${String(err.code)}${err.signal ? ` signal ${err.signal}` : ""}`;
        reject(
          new Error(
            `${file} ${why} (elapsed ${elapsedMs}ms)\n--- stderr ---\n${stderr}\n--- stdout ---\n${stdout}`,
          ),
        );
      },
    );
  });
}

/**
 * Deadlines for the Windows DACL check, innermost first. The PowerShell child does a cold start and
 * then `Connect(PIPE_CONNECT_MS)`, so it gets its own bound, and the test bound adds time for
 * starting and closing the desktop. A stall therefore fails as a child timeout that prints the
 * stages the child reached, not as a bare Vitest timeout.
 */
const PIPE_CONNECT_MS = 5_000;
const DACL_CHILD_DEADLINE_MS = 20_000;
const DACL_TEST_DEADLINE_MS = 30_000;

type Call = { method: string; payload: unknown; clientId: string };

async function startDesktop(
  opts: { ttlMs?: number; handshakeTimeoutMs?: number; ledgerCapacity?: number } = {},
) {
  const staticKeyPair = generateStaticKeyPair();
  const registry = new MemoryClientRegistry(
    opts.ledgerCapacity ? { ledgerCapacity: opts.ledgerCapacity } : {},
  );
  const dialogs = new MessageQueue();
  let dismissed = 0;
  const pairing = new PairingController({
    present: (prompt, dialog) => {
      dialogs.push({ prompt, dialog });
      return () => void dismissed++;
    },
    ...(opts.ttlMs ? { ttlMs: opts.ttlMs } : {}),
  });
  const calls: Call[] = [];
  const handler = (scope: Scope, mutation: boolean): MethodHandler => ({
    scope,
    mutation,
    handle: async (payload, ctx) => {
      calls.push({ method: "", payload, clientId: ctx.client.id });
      return { ok: true, echo: payload };
    },
  });
  const handlers = {
    "capture.create": handler(S.CaptureWrite, true),
    "search.query": handler(S.SearchRead, false),
  };
  const server = new IpcServer({
    staticKeyPair,
    coreVersion: "0.0.0-test",
    registry,
    pairing,
    handlers,
    handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 3000,
  });
  const path = endpoint();
  await server.listen(path);
  cleanups.push(() => server.close());
  return {
    staticKeyPair,
    registry,
    pairing,
    handlers,
    calls,
    server,
    path,
    get dismissed() {
      return dismissed;
    },
    nextDialog: () => dialogs.next() as Promise<{ prompt: PairingPrompt; dialog: PairingDialog }>,
  };
}
type Desktop = Awaited<ReturnType<typeof startDesktop>>;

function identity(kind: ClientIdentity["kind"] = "extension"): ClientIdentity {
  return { kind, version: "0.0.0-test", staticKeyPair: generateStaticKeyPair() };
}

async function open(path: string): Promise<MessageTransport> {
  const t = socketTransport(await connectIpc(path));
  cleanups.push(() => t.close());
  return t;
}

/** Pairs the way a person does: types the client's code into the desktop, then the desktop's into the client. */
async function pair(desk: Desktop, id: ClientIdentity, scopes: Scope[], path = desk.path) {
  let shown!: (c: string) => void;
  const code = new Promise<string>((r) => (shown = r));
  let typed!: (c: string) => void;
  const desktopCode = new Promise<string>((r) => (typed = r));
  const result = pairWithDesktop({
    transport: await open(path),
    identity: id,
    scopes,
    showCode: shown,
    enterDesktopCode: () => desktopCode,
  });
  const { prompt, dialog } = await desk.nextDialog();
  expect(prompt.scopes).toEqual(scopes);
  expect(dialog.submit(await code)).toBe("ok");
  typed(dialog.desktopCode()!);
  return result;
}

async function session(path: string, id: ClientIdentity, paired: PairingResult) {
  const s = await connectSession({
    transport: await open(path),
    identity: id,
    desktopPublicKey: paired.desktopPublicKey,
  });
  cleanups.push(() => s.close());
  return s;
}

/** Collects frames until the peer closes (or `ms` passes). */
async function drain(
  t: MessageTransport,
  ms = 3000,
): Promise<{ frames: unknown[]; closed: boolean }> {
  const frames: unknown[] = [];
  const deadline = Date.now() + ms;
  for (;;) {
    const left = deadline - Date.now();
    if (left <= 0) return { frames, closed: false };
    const r = await Promise.race([
      t.receive().then(
        (f) => ({ f }),
        (e: unknown) => ({ e }),
      ),
      new Promise<{ timeout: true }>((res) => setTimeout(() => res({ timeout: true }), left)),
    ]);
    if ("timeout" in r) return { frames, closed: false };
    if ("e" in r) return { frames, closed: r.e instanceof TransportClosedError };
    frames.push(r.f);
  }
}

/** For clients that must fail before the desktop shows its code. */
const notReached = () => Promise.reject(new Error("the desktop code must not be asked for"));

type Tamper = (dir: "up" | "down", frame: unknown, index: number) => unknown[];

/** A same-user process sitting between client and core: it sees and may rewrite every frame. */
async function startRelay(target: string, tamper?: Tamper) {
  const path = endpoint();
  await prepareListenPath(path);
  const log: { dir: "up" | "down"; frame: unknown }[] = [];
  const sockets = new Set<Socket>();
  const server: Server = createServer((down) => {
    const up = netConnect(target);
    sockets.add(down).add(up);
    const pipe = (from: Socket, to: Socket, d: "up" | "down") => {
      const dec = new FrameDecoder({ maxFrameBytes: 1 << 20 });
      let i = 0;
      from.on("data", (chunk: Buffer) => {
        for (const f of dec.push(chunk)) {
          log.push({ dir: d, frame: f });
          for (const out of tamper ? tamper(d, f, i++) : [f]) to.write(encodeFrame(out));
        }
      });
      from.on("close", () => to.destroy());
      from.on("error", () => undefined);
    };
    pipe(down, up, "up");
    pipe(up, down, "down");
  });
  await new Promise<void>((r) => server.listen(path, r));
  cleanups.push(async () => {
    for (const s of sockets) s.destroy();
    await new Promise<void>((r) => server.close(() => r()));
  });
  return { path, log };
}

const isRec = (f: unknown): f is { type: "rec"; d: string } =>
  (f as { type?: unknown }).type === "rec";

function flipLastByte(b64: string): string {
  const b = fromBase64(b64);
  b[b.length - 1]! ^= 1;
  return toBase64(b);
}

async function pairedClient(desk: Desktop, scopes: Scope[] = [S.CaptureWrite, S.SearchRead]) {
  const id = identity();
  const paired = await pair(desk, id, scopes);
  return { id, paired };
}

type FakeScript = (io: {
  keys: { handshakeHash: Uint8Array };
  send: (m: unknown) => void;
  recv: () => Promise<unknown>;
}) => Promise<void>;

/** A process listening where the client expects the desktop, running XX with its own key. */
async function fakeDesktop(script: FakeScript, desktopKeys = generateStaticKeyPair()) {
  const path = endpoint();
  await prepareListenPath(path);
  const server = createServer((sock) => {
    const t = socketTransport(sock);
    void (async () => {
      const hello = (await t.receive()) as Hello;
      const reply: HelloReply = { type: "hello.ok", version: 1, core: { version: "evil" } };
      t.send(reply);
      const hs = new Handshake({
        pattern: "XX",
        initiator: false,
        staticKeyPair: desktopKeys,
        prologue: helloPrologue(hello, reply),
      });
      while (!hs.complete) {
        if (hs.isMyTurn) t.send({ type: "hs", d: toBase64(hs.writeMessage()) });
        else hs.readMessage(fromBase64(((await t.receive()) as { d: string }).d));
      }
      const keys = hs.result();
      const ch = new SecureChannel(keys);
      await script({
        keys,
        send: (m) => ch.seal(m).forEach((f) => t.send(f)),
        recv: async () => {
          for (;;) {
            const m = ch.open((await t.receive()) as { type: "rec"; d: string });
            if (m !== undefined) return m;
          }
        },
      });
    })().catch(() => undefined);
  });
  await new Promise<void>((r) => server.listen(path, r));
  cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
  return path;
}

describe("T06: happy path", () => {
  test("pairing, then a scoped request over an encrypted session", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    expect(paired.desktopPublicKey).toEqual(desk.staticKeyPair.publicKey);
    expect(desk.registry.list()).toHaveLength(1);
    expect(desk.dismissed).toBe(1);
    const s = await session(desk.path, id, paired);
    await expect(s.request("search.query", { q: MARKER })).resolves.toEqual({
      ok: true,
      echo: { q: MARKER },
    });
    expect(desk.calls).toHaveLength(1);
  });

  test("the desktop stores only the client's public key and grants (SEC-04)", async () => {
    const desk = await startDesktop();
    const { id } = await pairedClient(desk);
    const stored = JSON.stringify(
      desk.registry.list().map((c) => ({ ...c, publicKey: toBase64(c.publicKey) })),
    );
    expect(stored).not.toContain(toBase64(id.staticKeyPair.secretKey));
    expect(Object.keys(desk.registry.list()[0]!).sort()).toEqual(
      ["createdAt", "id", "kind", "publicKey", "scopes"].sort(),
    );
  });

  test("a mutation retried with the same request ID runs once (§14)", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const a = await session(desk.path, id, paired);
    const opts = { mutation: true, id: "req-1" };
    await a.request("capture.create", { n: 1 }, opts);
    a.close();
    const b = await session(desk.path, id, paired);
    await expect(b.request("capture.create", { n: 1 }, opts)).resolves.toEqual({
      ok: true,
      echo: { n: 1 },
    });
    await expect(b.request("capture.create", { n: 2 }, opts)).rejects.toMatchObject({
      error: { code: ErrorCode.IdempotencyConflict },
    });
    expect(desk.calls).toHaveLength(1);
  });

  test("the replay ledger outlives the server: a retry through a restarted listener runs once", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const a = await session(desk.path, id, paired);
    const opts = { mutation: true, id: "req-restart" };
    await a.request("capture.create", { n: 1 }, opts);
    await desk.server.close();
    // Same desktop key and the same (eventually durable) client registry, new server instance.
    const restarted = new IpcServer({
      staticKeyPair: desk.staticKeyPair,
      coreVersion: "0.0.0-test",
      registry: desk.registry,
      pairing: desk.pairing,
      handlers: desk.handlers,
    });
    const path = endpoint();
    await restarted.listen(path);
    cleanups.push(() => restarted.close());
    const b = await session(path, id, paired);
    await expect(b.request("capture.create", { n: 1 }, opts)).resolves.toEqual({
      ok: true,
      echo: { n: 1 },
    });
    await expect(b.request("capture.create", { n: 9 }, opts)).rejects.toMatchObject({
      error: { code: ErrorCode.IdempotencyConflict },
    });
    expect(desk.calls).toHaveLength(1);
  });

  test("a full replay ledger refuses new mutations instead of forgetting old ones", async () => {
    const desk = await startDesktop({ ledgerCapacity: 2 });
    const { id, paired } = await pairedClient(desk);
    const s = await session(desk.path, id, paired);
    const m = (n: number) => s.request("capture.create", { n }, { mutation: true, id: `r${n}` });
    await m(1);
    await m(2);
    await expect(m(3)).rejects.toMatchObject({ error: { code: ErrorCode.IdempotencyExhausted } });
    await expect(m(1)).resolves.toEqual({ ok: true, echo: { n: 1 } });
    // Reads do not consume ledger capacity.
    await expect(s.request("search.query", {})).resolves.toMatchObject({ ok: true });
    expect(desk.calls.map((c) => c.payload)).toEqual([{ n: 1 }, { n: 2 }, {}]);
  });

  test("revocation drops the client's ledger together with its key", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const s = await session(desk.path, id, paired);
    await s.request("capture.create", { n: 1 }, { mutation: true, id: "same" });
    desk.server.revoke(paired.clientId);
    expect(desk.registry.ledger(paired.clientId)).toBeUndefined();
  });

  test("a request the client cannot send fails as a promise and leaves the session usable", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const s = await session(desk.path, id, paired);
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const bad: unknown[] = [{ n: 1n }, circular, { s: "x".repeat(9 * 1024 * 1024) }];
    for (const payload of bad) {
      let p: Promise<unknown> | undefined;
      expect(() => (p = s.request("search.query", payload, { id: "retry-me" }))).not.toThrow();
      await expect(p).rejects.toBeInstanceOf(Error);
    }
    // The ID is free again and the channel was never advanced.
    await expect(s.request("search.query", { ok: 1 }, { id: "retry-me" })).resolves.toMatchObject({
      echo: { ok: 1 },
    });
    expect(desk.calls).toHaveLength(1);
  });
});

/** Resolves to how `p` settled, or "pending" if it has not settled within `ms`. */
function settlement(p: Promise<unknown> | undefined, ms = 2000) {
  return Promise.race([
    Promise.resolve(p).then(
      () => "resolved" as const,
      () => "rejected" as const,
    ),
    new Promise<"pending">((r) => setTimeout(() => r("pending"), ms)),
  ]);
}

describe("T06: request lifecycle", () => {
  test("a payload that re-enters request() while serialising cannot steal or orphan its ID", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const s = await session(desk.path, id, paired);
    let inner: Promise<unknown> | undefined;
    const payload = {
      toJSON() {
        inner ??= s.request("search.query", { which: "inner" }, { id: "reentry" });
        inner.catch(() => undefined);
        return { which: "outer" };
      },
    };
    const outer = s.request("search.query", payload, { id: "reentry" });
    await expect(outer).resolves.toEqual({ ok: true, echo: { which: "outer" } });
    await expect(settlement(inner)).resolves.toBe("rejected");
    await expect(inner).rejects.toThrow("request ID already in flight");
    expect(desk.calls.map((c) => c.payload)).toEqual([{ which: "outer" }]);
  });

  test("a payload that fails after re-entering frees only its own ID and the inner request completes", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const s = await session(desk.path, id, paired);
    let other: Promise<unknown> | undefined;
    let same: Promise<unknown> | undefined;
    const payload = {
      toJSON() {
        other = s.request("search.query", { which: "other" }, { id: "other" });
        same = s.request("search.query", { which: "same" }, { id: "outer" });
        same.catch(() => undefined);
        throw new Error("payload refused");
      },
    };
    await expect(s.request("search.query", payload, { id: "outer" })).rejects.toThrow(
      "payload refused",
    );
    await expect(same).rejects.toThrow("request ID already in flight");
    await expect(other).resolves.toEqual({ ok: true, echo: { which: "other" } });
    await expect(s.request("search.query", { n: 1 }, { id: "outer" })).resolves.toEqual({
      ok: true,
      echo: { n: 1 },
    });
    expect(desk.calls.map((c) => c.payload)).toEqual([{ which: "other" }, { n: 1 }]);
  });

  test("closing the session while a payload serialises rejects the request and sends nothing", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const s = await session(desk.path, id, paired);
    const outer = s.request(
      "search.query",
      {
        toJSON() {
          s.close();
          return {};
        },
      },
      { id: "closing" },
    );
    await expect(settlement(outer)).resolves.toBe("rejected");
    await expect(outer).rejects.toBeInstanceOf(TransportClosedError);
    expect(desk.calls).toHaveLength(0);
  });

  test("a response the core cannot send closes the connection and every pending request fails", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let calls = 0;
    const server = new IpcServer({
      staticKeyPair: desk.staticKeyPair,
      coreVersion: "0.0.0-test",
      registry: desk.registry,
      pairing: desk.pairing,
      handlers: {
        "search.query": {
          scope: S.SearchRead,
          mutation: false,
          handle: async (payload) => {
            calls++;
            if ((payload as { wait?: boolean }).wait) await gate;
            return { ok: true };
          },
        },
      },
    });
    cleanups.push(() => server.close());
    // A real socket whose server side starts failing encrypted sends, as a broken pipe would.
    let failing = false;
    let sendFailures = 0;
    let serverClosedTransport = false;
    const path = endpoint();
    await prepareListenPath(path);
    const listener = createServer((sock) => {
      sock.on("error", () => undefined);
      const t = socketTransport(sock);
      void server.serve({
        receive: () => t.receive(),
        close: () => {
          serverClosedTransport = true;
          t.close();
        },
        send: (m) => {
          if (failing && isRec(m)) {
            sendFailures++;
            throw new Error("injected response send failure");
          }
          t.send(m);
        },
      });
    });
    await new Promise<void>((r) => listener.listen(path, r));
    cleanups.push(() => new Promise<void>((r) => listener.close(() => r())));
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown) => void unhandled.push(e);
    process.on("unhandledRejection", onUnhandled);
    cleanups.push(() => void process.off("unhandledRejection", onUnhandled));

    const s = await session(path, id, paired);
    failing = true;
    const waiting = s.request("search.query", { wait: true }, { id: "waiting" });
    await expect.poll(() => calls).toBe(1);
    const answered = s.request("search.query", {}, { id: "answered" });
    await expect(settlement(answered)).resolves.toBe("rejected");
    await expect(settlement(waiting)).resolves.toBe("rejected");
    await expect(settlement(s.closed)).resolves.toBe("resolved");
    expect(serverClosedTransport).toBe(true);
    release();
    await new Promise((r) => setTimeout(r, 50));
    // One failed send, no retry over the broken transport, and nothing escapes as an unhandled rejection.
    expect(sendFailures).toBe(1);
    expect(calls).toBe(2);
    expect(unhandled).toEqual([]);
  });
});

describe("T06: clients that must be refused", () => {
  test("incompatible protocol version gets a structured error and nothing else", async () => {
    const desk = await startDesktop();
    const id = { ...identity(), versions: { min: 2, max: 3 } };
    const err = await connectSession({
      transport: await open(desk.path),
      identity: id,
      desktopPublicKey: desk.staticKeyPair.publicKey,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HelloRejectedError);
    expect((err as HelloRejectedError).error.code).toBe(ErrorCode.Incompatible);
    expect(desk.calls).toHaveLength(0);
  });

  test("an unpaired client gets no handshake reply and no data", async () => {
    const desk = await startDesktop();
    const relay = await startRelay(desk.path);
    const err = await connectSession({
      transport: await open(relay.path),
      identity: identity(),
      desktopPublicKey: desk.staticKeyPair.publicKey,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    const down = relay.log
      .filter((l) => l.dir === "down")
      .map((l) => (l.frame as { type: string }).type);
    expect(down).toEqual(["hello.ok"]);
    expect(desk.calls).toHaveLength(0);
  });

  test("a paired key presented as another client kind is refused", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    await expect(session(desk.path, { ...id, kind: "obsidian-plugin" }, paired)).rejects.toThrow();
  });

  test("desktop-ui is not reachable over the socket", async () => {
    const desk = await startDesktop();
    const err = await connectSession({
      transport: await open(desk.path),
      identity: identity("desktop-ui"),
      desktopPublicKey: desk.staticKeyPair.publicKey,
    }).catch((e: unknown) => e);
    expect((err as HelloRejectedError).error.code).toBe(ErrorCode.Unauthorized);
  });

  test("revocation closes open connections at once and blocks reconnecting", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const s = await session(desk.path, id, paired);
    await s.request("search.query", {});
    expect(desk.server.revoke(paired.clientId)).toBe(true);
    await expect(s.closed).resolves.toBeInstanceOf(Error);
    await expect(s.request("search.query", {})).rejects.toThrow();
    await expect(session(desk.path, id, paired)).rejects.toThrow();
    expect(desk.calls).toHaveLength(1);
  });

  test("a request outside the client's scopes is forbidden and the handler never runs", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk, [S.SearchRead]);
    const s = await session(desk.path, id, paired);
    const err = await s
      .request("capture.create", { x: 1 }, { mutation: true })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RequestError);
    expect((err as RequestError).error.code).toBe(ErrorCode.Forbidden);
    await expect(s.request("nope", {})).rejects.toMatchObject({
      error: { code: ErrorCode.NotFound },
    });
    await expect(s.request("search.query", {}, { mutation: true })).rejects.toMatchObject({
      error: { code: ErrorCode.InvalidMessage },
    });
    expect(desk.calls).toHaveLength(0);
  });

  test("a client cannot request clients.manage", async () => {
    const desk = await startDesktop();
    const err = await pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: ["clients.manage" as Scope],
      showCode: () => undefined,
      enterDesktopCode: notReached,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(desk.pairing.pending).toBe(false);
    expect(desk.registry.list()).toHaveLength(0);
  });

  test("plaintext requests before or instead of the handshake are refused", async () => {
    const desk = await startDesktop();
    const req = { v: 1, id: "x", method: "capture.create", mutation: true, payload: { MARKER } };
    const a = await open(desk.path);
    a.send(req);
    const ra = await drain(a);
    expect(ra.closed).toBe(true);
    expect(ra.frames).toMatchObject([{ type: "hello.error", error: { code: "invalid_message" } }]);

    const b = await open(desk.path);
    const hello: Hello = {
      type: "hello",
      versions: { min: 1, max: 1 },
      client: { kind: "extension", version: "1" },
      channel: "session",
    };
    b.send(hello);
    b.send(req);
    const rb = await drain(b);
    expect(rb.closed).toBe(true);
    expect(rb.frames.map((f) => (f as { type: string }).type)).toEqual(["hello.ok"]);
    expect(desk.calls).toHaveLength(0);
  });

  test("a silent connection is dropped after the handshake timeout", async () => {
    const desk = await startDesktop({ handshakeTimeoutMs: 200 });
    const t = await open(desk.path);
    const r = await drain(t, 2000);
    expect(r).toEqual({ frames: [], closed: true });
  });

  test("a pairing client that stalls before the code exists is dropped and frees the slot", async () => {
    const desk = await startDesktop({ handshakeTimeoutMs: 300 });
    const raw = await open(desk.path);
    let records = 0;
    // Completes XX and sends pair.request, then never sends pair.nonce.
    const stalling: MessageTransport = {
      send: (f) => {
        if (isRec(f) && ++records > 1) return;
        raw.send(f);
      },
      receive: () => raw.receive(),
      close: () => raw.close(),
    };
    const err = await pairWithDesktop({
      transport: stalling,
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: () => undefined,
      enterDesktopCode: notReached,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(desk.pairing.pending).toBe(false);
    const id = identity();
    await expect(pair(desk, id, [S.CaptureWrite])).resolves.toMatchObject({
      scopes: [S.CaptureWrite],
    });
  });
});

describe("T06: replay", () => {
  test("a recorded session replayed to the core runs nothing", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const relay = await startRelay(desk.path);
    const s = await session(relay.path, id, paired);
    await s.request("capture.create", { MARKER }, { mutation: true });
    s.close();
    expect(desk.calls).toHaveLength(1);
    const recorded = relay.log.filter((l) => l.dir === "up").map((l) => l.frame);

    const t = await open(desk.path);
    for (const f of recorded) t.send(f);
    const r = await drain(t);
    expect(r.closed).toBe(true);
    expect(r.frames.filter(isRec)).toHaveLength(0);
    expect(desk.calls).toHaveLength(1);
  });

  test("a recorded pairing replayed to the core pairs nothing and opens no dialog", async () => {
    const desk = await startDesktop();
    const relay = await startRelay(desk.path);
    await pair(desk, identity(), [S.SearchRead], relay.path);
    desk.registry.list().forEach((c) => desk.server.revoke(c.id));
    const recorded = relay.log.filter((l) => l.dir === "up").map((l) => l.frame);

    const t = await open(desk.path);
    for (const f of recorded) t.send(f);
    const r = await drain(t);
    expect(r.closed).toBe(true);
    expect(r.frames.filter(isRec)).toHaveLength(0);
    expect(desk.registry.list()).toHaveLength(0);
    expect(desk.pairing.pending).toBe(false);
  });
});

describe("T06: relayed and injected frames", () => {
  test("a pure relay forwards the session but never sees plaintext", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const relay = await startRelay(desk.path);
    const s = await session(relay.path, id, paired);
    await expect(s.request("search.query", { q: MARKER })).resolves.toMatchObject({
      echo: { q: MARKER },
    });
    expect(JSON.stringify(relay.log)).not.toContain(MARKER);
    expect(JSON.stringify(relay.log)).not.toContain("search.query");
  });

  const attacks: [string, Tamper][] = [
    ["modified", (d, f) => (d === "up" && isRec(f) ? [{ ...f, d: flipLastByte(f.d) }] : [f])],
    [
      "injected from elsewhere",
      (d, f) => (d === "up" && isRec(f) ? [{ type: "rec", d: toBase64(pairingNonce()) }, f] : [f]),
    ],
    ["duplicated", (d, f) => (d === "up" && isRec(f) ? [f, f] : [f])],
    [
      "plaintext",
      (d, f) =>
        d === "up" && isRec(f)
          ? [{ v: 1, id: "evil", method: "capture.create", mutation: true, payload: { MARKER } }, f]
          : [f],
    ],
  ];
  test.each(attacks)(
    "a %s frame closes the session and runs no extra handler",
    async (_n, tamper) => {
      const desk = await startDesktop();
      const { id, paired } = await pairedClient(desk);
      const relay = await startRelay(desk.path, tamper);
      const s = await session(relay.path, id, paired);
      const r = await s
        .request("capture.create", { n: 1 }, { mutation: true })
        .catch((e: unknown) => e);
      await s.closed;
      // A duplicate arrives after the original was accepted: the original may run, the copy never does.
      expect(desk.calls.length).toBeLessThanOrEqual(_n === "duplicated" ? 1 : 0);
      if (_n !== "duplicated") expect(r).toBeInstanceOf(Error);
      expect(desk.calls.every((c) => !JSON.stringify(c.payload).includes(MARKER))).toBe(true);
    },
  );

  test("reordered records close the session; neither request runs out of order", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    let held: unknown;
    const relay = await startRelay(desk.path, (d, f) => {
      if (d !== "up" || !isRec(f)) return [f];
      if (held === undefined) {
        held = f;
        return [];
      }
      return [f, held];
    });
    const s = await session(relay.path, id, paired);
    const a = s.request("capture.create", { n: 1 }, { mutation: true }).catch((e: unknown) => e);
    const b = s.request("capture.create", { n: 2 }, { mutation: true }).catch((e: unknown) => e);
    expect(await a).toBeInstanceOf(Error);
    expect(await b).toBeInstanceOf(Error);
    expect(desk.calls).toHaveLength(0);
  });

  test("a modified response from the core is rejected by the client", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const relay = await startRelay(desk.path, (d, f) =>
      d === "down" && isRec(f) ? [{ ...f, d: flipLastByte(f.d) }] : [f],
    );
    const s = await session(relay.path, id, paired);
    await expect(s.request("search.query", {})).rejects.toThrow();
  });

  test("a fake desktop with another key cannot complete the handshake or read the request", async () => {
    const desk = await startDesktop();
    const { id, paired } = await pairedClient(desk);
    const fake = await startDesktop();
    const relay = await startRelay(fake.path);
    await expect(session(relay.path, id, paired)).rejects.toThrow();
    expect(relay.log.filter((l) => isRec(l.frame))).toHaveLength(0);
    expect(fake.calls).toHaveLength(0);
  });
});

describe("T06: pairing", () => {
  test("a local process cannot pair itself: without a person typing the code it expires", async () => {
    const desk = await startDesktop({ ttlMs: 300 });
    let rogueCode = "";
    const err = await pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: (c) => (rogueCode = c),
      enterDesktopCode: notReached,
    }).catch((e: unknown) => e);
    expect(rogueCode).toMatch(/^\d{6}$/);
    expect((err as PairingError).error.code).toBe(ErrorCode.PairingExpired);
    expect(desk.registry.list()).toHaveLength(0);
    const { dialog } = await desk.nextDialog();
    expect(dialog.submit(rogueCode)).toBe("expired");
  });

  test("a man in the middle shows the user a code the desktop rejects", async () => {
    const desk = await startDesktop();
    const mitm = await startDesktop();
    let clientCode!: (c: string) => void;
    const shownToUser = new Promise<string>((r) => (clientCode = r));
    let mitmCode!: (c: string) => void;
    const mitmSees = new Promise<string>((r) => (mitmCode = r));
    const victim = pairWithDesktop({
      transport: await open(mitm.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: clientCode,
      enterDesktopCode: notReached,
    }).catch((e: unknown) => e);
    const attacker = pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: mitmCode,
      enterDesktopCode: notReached,
    }).catch((e: unknown) => e);
    const { dialog } = await desk.nextDialog();
    const userTyped = await shownToUser;
    expect(userTyped).not.toBe(await mitmSees);
    expect(dialog.submit(userTyped)).toBe("wrong");
    dialog.cancel();
    expect((await attacker) as PairingError).toBeInstanceOf(PairingError);
    (await mitm.nextDialog()).dialog.cancel();
    expect(await victim).toBeInstanceOf(PairingError);
    expect(desk.registry.list()).toHaveLength(0);
  });

  test("a desktop that breaks its nonce commitment is caught before any code is shown", async () => {
    const path = await fakeDesktop(async ({ keys, send, recv }) => {
      await recv();
      send({
        type: "pair.commit",
        commit: toBase64(commitToNonce(keys.handshakeHash, pairingNonce())),
      });
      await recv();
      send({ type: "pair.reveal", nonce: toBase64(pairingNonce()) });
      await recv();
    });
    let shown = false;
    const err = await pairWithDesktop({
      transport: await open(path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: () => (shown = true),
      enterDesktopCode: () => Promise.reject(new Error("must not be asked")),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PairingError);
    expect(shown).toBe(false);
  });

  // A same-user (or, for a Windows pipe name, any-user) process squatting the endpoint runs XX with its own
  // key and an honest commit/reveal, then claims success. No Citspark dialog ever showed a code, so the
  // person has nothing true to type into the client, and the client must not pin the squatter's key.
  test.each([
    ["pair.ok straight away", ["pair.ok"]],
    ["pair.approved then pair.ok", ["pair.approved", "pair.ok"]],
  ])("a socket squatter that sends %s is not accepted as the desktop", async (_n, script) => {
    const squatterKeys = generateStaticKeyPair();
    const path = await fakeDesktop(async ({ keys, send, recv }) => {
      await recv();
      const nd = pairingNonce();
      send({ type: "pair.commit", commit: toBase64(commitToNonce(keys.handshakeHash, nd)) });
      await recv();
      send({ type: "pair.reveal", nonce: toBase64(nd) });
      for (const type of script) {
        send(type === "pair.ok" ? { type, clientId: "evil", scopes: [S.CaptureWrite] } : { type });
      }
      await recv();
    }, squatterKeys);
    let shown = "";
    const err = await pairWithDesktop({
      transport: await open(path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: (c) => (shown = c),
      // The real Citspark window shows no confirmation code; the person types what they see (nothing).
      enterDesktopCode: () => Promise.resolve(""),
    }).catch((e: unknown) => e);
    expect(shown).toMatch(/^\d{6}$/);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toHaveProperty("desktopPublicKey");
  });

  test("the client pins the desktop only after the person types the code the desktop shows", async () => {
    const desk = await startDesktop();
    let shown!: (c: string) => void;
    const code = new Promise<string>((r) => (shown = r));
    let asked!: (c: string) => void;
    const typedIntoClient = new Promise<string>((r) => (asked = r));
    let settled = false;
    const result = pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.SearchRead],
      showCode: shown,
      enterDesktopCode: () => typedIntoClient,
    }).finally(() => (settled = true));
    const { dialog } = await desk.nextDialog();
    expect(dialog.desktopCode()).toBeUndefined();
    expect(dialog.submit(await code)).toBe("ok");
    const desktopCode = dialog.desktopCode();
    expect(desktopCode).toMatch(/^\d{6}$/);
    expect(desktopCode).not.toBe(await code);
    await new Promise((r) => setTimeout(r, 50));
    expect(settled).toBe(false);
    expect(desk.registry.list()).toHaveLength(0);
    asked(desktopCode!);
    await expect(result).resolves.toMatchObject({ desktopPublicKey: desk.staticKeyPair.publicKey });
    expect(desk.registry.list()).toHaveLength(1);
  });

  test("a wrong code typed into the client stops pairing and the desktop registers nothing", async () => {
    const desk = await startDesktop();
    let shown!: (c: string) => void;
    const code = new Promise<string>((r) => (shown = r));
    let asked!: (c: string) => void;
    const typedIntoClient = new Promise<string>((r) => (asked = r));
    const result = pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.SearchRead],
      showCode: shown,
      enterDesktopCode: () => typedIntoClient,
    }).catch((e: unknown) => e);
    const { dialog } = await desk.nextDialog();
    expect(dialog.submit(await code)).toBe("ok");
    asked("not the code");
    expect(((await result) as PairingError).error.code).toBe(ErrorCode.PairingFailed);
    await expect.poll(() => desk.pairing.pending).toBe(false);
    expect(desk.registry.list()).toHaveLength(0);
  });

  test("five wrong codes lock pairing until the desktop user unlocks it", async () => {
    const desk = await startDesktop();
    const rogue = pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: () => undefined,
      enterDesktopCode: notReached,
    }).catch((e: unknown) => e);
    const { dialog } = await desk.nextDialog();
    const results = ["000000", "111111", "222222", "333333", "444444"].map((c) => dialog.submit(c));
    // A real code could be one of these by chance (5 in 10^6); the flow still must end locked or ok.
    if (!results.includes("ok")) {
      expect(results).toEqual(["wrong", "wrong", "wrong", "wrong", "locked"]);
      expect(((await rogue) as PairingError).error.code).toBe(ErrorCode.PairingLocked);
      expect(desk.pairing.locked).toBe(true);
      const again = await pairWithDesktop({
        transport: await open(desk.path),
        identity: identity(),
        scopes: [S.CaptureWrite],
        showCode: () => undefined,
        enterDesktopCode: notReached,
      }).catch((e: unknown) => e);
      expect((again as PairingError).error.code).toBe(ErrorCode.PairingLocked);
      desk.pairing.unlock();
      await expect(pair(desk, identity(), [S.CaptureWrite])).resolves.toMatchObject({
        scopes: [S.CaptureWrite],
      });
    }
  });

  test("codes are single-use and one pairing runs at a time", async () => {
    const desk = await startDesktop();
    let code!: (c: string) => void;
    const shown = new Promise<string>((r) => (code = r));
    let confirm!: (c: string) => void;
    const confirmed = new Promise<string>((r) => (confirm = r));
    const first = pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: code,
      enterDesktopCode: () => confirmed,
    });
    const { dialog } = await desk.nextDialog();
    const second = await pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: () => undefined,
      enterDesktopCode: notReached,
    }).catch((e: unknown) => e);
    expect((second as PairingError).error.code).toBe(ErrorCode.PairingFailed);
    const c = await shown;
    expect(dialog.submit(c)).toBe("ok");
    confirm(dialog.desktopCode()!);
    await first;
    expect(dialog.submit(c)).toBe("expired");
    expect(desk.registry.list()).toHaveLength(1);
  });

  test("an already paired key cannot pair again", async () => {
    const desk = await startDesktop();
    const { id } = await pairedClient(desk);
    const err = await pairWithDesktop({
      transport: await open(desk.path),
      identity: id,
      scopes: [S.AnswerRun],
      showCode: () => undefined,
      enterDesktopCode: notReached,
    }).catch((e: unknown) => e);
    expect((err as PairingError).error.code).toBe(ErrorCode.PairingFailed);
    expect(desk.registry.list()[0]!.scopes).toEqual([S.CaptureWrite, S.SearchRead]);
  });

  test("aborting on the client closes the desktop dialog", async () => {
    const desk = await startDesktop();
    const ac = new AbortController();
    const p = pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: () => undefined,
      enterDesktopCode: notReached,
      signal: ac.signal,
    }).catch((e: unknown) => e);
    const { dialog } = await desk.nextDialog();
    ac.abort();
    await p;
    await expect.poll(() => desk.dismissed).toBe(1);
    expect(dialog.submit("123456")).toBe("expired");
    expect(desk.pairing.pending).toBe(false);
  });
});

describe("pairing policy (unit)", () => {
  test("the desktop registers nothing until the client confirms, and an early confirm is refused", () => {
    const shown: PairingDialog[] = [];
    const ends: string[] = [];
    let approvals = 0;
    const ctl = new PairingController({ present: (_p, d) => (shown.push(d), () => undefined) });
    const p = ctl.begin({
      clientKind: "extension",
      scopes: [S.SearchRead],
      onApproved: () => approvals++,
      onEnd: (o) => ends.push(o),
    });
    p.open("123456", "654321");
    const dialog = shown[0]!;
    expect(p.complete()).toBe(false); // pair.accept before the user typed the client's code
    expect(dialog.desktopCode()).toBeUndefined();
    expect(dialog.submit("123456")).toBe("ok");
    expect(approvals).toBe(1);
    expect(p.approved).toBe(true);
    expect(ctl.pending).toBe(true); // the slot stays reserved while the client confirms
    expect(dialog.desktopCode()).toBe("654321");
    expect(dialog.submit("123456")).toBe("expired"); // single use
    expect(p.complete()).toBe(true);
    expect(ends).toEqual(["ok"]);
    expect(dialog.desktopCode()).toBeUndefined();
    expect(ctl.pending).toBe(false);
  });

  test("the deadline also covers the client's confirmation", () => {
    let now = 0;
    const ends: string[] = [];
    let dialog!: PairingDialog;
    const ctl = new PairingController({
      present: (_p, d) => ((dialog = d), () => undefined),
      now: () => now,
      ttlMs: 1000,
    });
    const p = ctl.begin({
      clientKind: "extension",
      scopes: [S.SearchRead],
      onEnd: (o) => ends.push(o),
    });
    p.open("123456", "654321");
    expect(dialog.submit("123456")).toBe("ok");
    now = 1000;
    expect(p.complete()).toBe(false);
    expect(ends).toEqual(["expired"]);
  });
});

describe("T06 harness: bounded child process", () => {
  const node = (src: string) => [process.execPath, ["-e", src]] as const;

  test("a child that outlives its deadline is killed and the error carries its output sections", async () => {
    // Models a cold start slower than the deadline: the child prints nothing before it is killed.
    // Whether a real child reaches any stage before its deadline is not guaranteed, so this checks
    // only the kill and the diagnostic layout; stage preservation is checked by the exit-code test.
    const [file, args] = node(
      `setTimeout(() => process.stderr.write("stage=connect t=1\\n"), 60_000); setInterval(() => undefined, 1000);`,
    );
    const started = Date.now();
    const err = (await runBounded(file, args, { deadlineMs: 500 }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(Date.now() - started).toBeLessThan(4000);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain("timed out after 500ms");
    expect(err.message).toMatch(/\(elapsed \d+ms\)/);
    expect(err.message).toContain("\n--- stderr ---\n");
    expect(err.message).toContain("\n--- stdout ---\n");
  });

  test(
    "a child that fails names its exit code and keeps its stderr",
    async () => {
      const [file, args] = node(`process.stderr.write("stage=getacl boom\\n"); process.exit(3);`);
      const err = (await runBounded(file, args, { deadlineMs: 10_000 }).catch(
        (e: unknown) => e,
      )) as Error;
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toContain("exited with code 3");
      expect(err.message).toContain("stage=getacl boom");
    },
    // Longer than the child's 10 s deadline, so a hung child fails with its own diagnostics.
    15_000,
  );

  test("each deadline in the DACL check fits inside the one that encloses it", () => {
    expect(PIPE_CONNECT_MS).toBeLessThan(DACL_CHILD_DEADLINE_MS);
    expect(DACL_CHILD_DEADLINE_MS).toBeLessThan(DACL_TEST_DEADLINE_MS);
  });
});

describe.runIf(isWin)("T06: Windows named pipe DACL", () => {
  test(
    "only the current user, SYSTEM, Administrators and the owner may write to the pipe",
    async () => {
      const desk = await startDesktop();
      const name = desk.path.slice("\\\\.\\pipe\\".length);
      // Reads the DACL from a connected handle: Get-Acl may not autoload on the runner, and FileSecurity
      // rejects \\.\pipe\ paths. The core sees this connection as a silent client and drops it.
      // Each stage goes to stderr with the ms since the script started, so a stall or failure in CI
      // shows how far the child got. A missing `stage=start` means PowerShell itself never started.
      const script = `
      $ErrorActionPreference = 'Stop'
      $sw = [System.Diagnostics.Stopwatch]::StartNew()
      function Stage($s) { [Console]::Error.WriteLine("stage=$s t=$($sw.ElapsedMilliseconds)") }
      Stage 'start'
      $pipe = New-Object System.IO.Pipes.NamedPipeClientStream -ArgumentList '.', '${name}', ([System.IO.Pipes.PipeDirection]::InOut)
      Stage 'connect'
      $pipe.Connect(${PIPE_CONNECT_MS})
      Stage 'getacl'
      $acl = $pipe.GetAccessControl()
      $pipe.Dispose()
      Stage 'rules'
      $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      @{ me = $me; owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
         rules = @($rules | ForEach-Object { @{ sid = $_.IdentityReference.Value;
           mask = [int64]$_.PipeAccessRights; type = [string]$_.AccessControlType } }) } |
        ConvertTo-Json -Depth 4 -Compress
      Stage 'done'`;
      const env = { ...process.env };
      delete env.PSModulePath;
      const { stdout, stderr, elapsedMs } = await runBounded(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { deadlineMs: DACL_CHILD_DEADLINE_MS, env },
      );
      console.info(`named pipe DACL child ${elapsedMs}ms`, stderr.trim().split(/\r?\n/).join(" "));
      const acl = JSON.parse(stdout) as {
        me: string;
        owner: string;
        rules: { sid: string; mask: number; type: string }[];
      };
      // FILE_WRITE_DATA, FILE_APPEND_DATA (create pipe instance), FILE_WRITE_EA, FILE_WRITE_ATTRIBUTES,
      // DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE.
      const WRITE =
        0x2 | 0x4 | 0x10 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
      const trusted = new Set([acl.me, "S-1-5-18", "S-1-5-32-544", "S-1-3-0"]);
      const writers = acl.rules.filter((r) => r.type === "Allow" && (r.mask & WRITE) !== 0);
      console.info("named pipe DACL", JSON.stringify(acl));
      // An elevated administrator's objects are owned by Administrators rather than by the user.
      expect([acl.me, "S-1-5-32-544"]).toContain(acl.owner);
      expect(writers.length).toBeGreaterThan(0);
      for (const w of writers) expect(trusted).toContain(w.sid);
    },
    DACL_TEST_DEADLINE_MS,
  );
});
