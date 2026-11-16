// T06 (pairing and local IPC security) against a real Unix socket or Windows named pipe. Synthetic data only.
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server, type Socket, connect as netConnect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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

type Call = { method: string; payload: unknown; clientId: string };

async function startDesktop(opts: { ttlMs?: number; handshakeTimeoutMs?: number } = {}) {
  const staticKeyPair = generateStaticKeyPair();
  const registry = new MemoryClientRegistry();
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

/** Pairs the way a person does: reads the code on the client and types it into the desktop dialog. */
async function pair(desk: Desktop, id: ClientIdentity, scopes: Scope[], path = desk.path) {
  let shown!: (c: string) => void;
  const code = new Promise<string>((r) => (shown = r));
  const result = pairWithDesktop({
    transport: await open(path),
    identity: id,
    scopes,
    showCode: shown,
  });
  const { prompt, dialog } = await desk.nextDialog();
  expect(prompt.scopes).toEqual(scopes);
  expect(dialog.submit(await code)).toBe("ok");
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
    }).catch((e: unknown) => e);
    const attacker = pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: mitmCode,
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
    const path = endpoint();
    await prepareListenPath(path);
    const desktopKeys = generateStaticKeyPair();
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
        const recv = async () => {
          for (;;) {
            const m = ch.open((await t.receive()) as { type: "rec"; d: string });
            if (m !== undefined) return m;
          }
        };
        await recv();
        ch.seal({
          type: "pair.commit",
          commit: toBase64(commitToNonce(keys.handshakeHash, pairingNonce())),
        }).forEach((f) => t.send(f));
        await recv();
        ch.seal({ type: "pair.reveal", nonce: toBase64(pairingNonce()) }).forEach((f) => t.send(f));
        await recv().catch(() => undefined);
      })().catch(() => undefined);
    });
    await new Promise<void>((r) => server.listen(path, r));
    cleanups.push(() => new Promise<void>((r) => server.close(() => r())));
    let shown = false;
    const err = await pairWithDesktop({
      transport: await open(path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: () => (shown = true),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PairingError);
    expect(shown).toBe(false);
  });

  test("five wrong codes lock pairing until the desktop user unlocks it", async () => {
    const desk = await startDesktop();
    const rogue = pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: () => undefined,
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
    const first = pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: code,
    });
    const { dialog } = await desk.nextDialog();
    const second = await pairWithDesktop({
      transport: await open(desk.path),
      identity: identity(),
      scopes: [S.CaptureWrite],
      showCode: () => undefined,
    }).catch((e: unknown) => e);
    expect((second as PairingError).error.code).toBe(ErrorCode.PairingFailed);
    const c = await shown;
    expect(dialog.submit(c)).toBe("ok");
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

describe.runIf(isWin)("T06: Windows named pipe DACL", () => {
  test("only the current user, SYSTEM, Administrators and the owner may write to the pipe", async () => {
    const desk = await startDesktop();
    const name = desk.path.slice("\\\\.\\pipe\\".length);
    const script = `
      $ErrorActionPreference = 'Stop'
      $acl = Get-Acl -LiteralPath '\\\\.\\pipe\\${name}'
      $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
      $me = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      @{ me = $me; owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;
         rules = @($rules | ForEach-Object { @{ sid = $_.IdentityReference.Value;
           mask = [int64]$_.FileSystemRights; type = [string]$_.AccessControlType } }) } |
        ConvertTo-Json -Depth 4 -Compress`;
    const { stdout } = await promisify(execFile)("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      script,
    ]);
    const acl = JSON.parse(stdout) as {
      me: string;
      owner: string;
      rules: { sid: string; mask: number; type: string }[];
    };
    // FILE_WRITE_DATA, FILE_APPEND_DATA (create pipe instance), FILE_WRITE_EA, FILE_WRITE_ATTRIBUTES,
    // DELETE, WRITE_DAC, WRITE_OWNER, GENERIC_ALL, GENERIC_WRITE.
    const WRITE = 0x2 | 0x4 | 0x10 | 0x100 | 0x10000 | 0x40000 | 0x80000 | 0x10000000 | 0x40000000;
    const trusted = new Set([acl.me, "S-1-5-18", "S-1-5-32-544", "S-1-3-0"]);
    const writers = acl.rules.filter((r) => r.type === "Allow" && (r.mask & WRITE) !== 0);
    console.info("named pipe DACL", JSON.stringify(acl));
    expect(acl.owner).toBe(acl.me);
    expect(writers.length).toBeGreaterThan(0);
    for (const w of writers) expect(trusted).toContain(w.sid);
  });
});
