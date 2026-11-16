import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, test } from "vitest";
import {
  IpcServer,
  MemoryClientRegistry,
  PairingController,
  type PairingDialog,
} from "@citspark/core";
import {
  connectSession,
  generateStaticKeyPair,
  MessageQueue,
  type MessageTransport,
  pairWithDesktop,
} from "@citspark/ipc";
import { connectIpc } from "@citspark/ipc/node";
import { Scope } from "@citspark/protocol";
import { RawFrameReader, writeRawFrame } from "./frames.ts";
import {
  checkOrigin,
  type HostConfig,
  parseHostConfig,
  runHost,
  TO_CORE_MAX_BYTES,
} from "./host.ts";

const EXT = `chrome-extension://${"a".repeat(32)}/`;
const OTHER = `chrome-extension://${"b".repeat(32)}/`;
const MARKER = "SYNTHETIC-HOST-MARKER-51c2";
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

describe("caller origin check (T06 wrong origin)", () => {
  const config: HostConfig = { allowedOrigins: [EXT], socketPath: "/nonexistent" };

  test.each([
    ["allowed origin", [EXT], true],
    ["allowed origin plus Windows parent window", [EXT, "--parent-window=1234"], true],
    ["another extension", [OTHER], false],
    ["no trailing slash", [EXT.slice(0, -1)], false],
    ["web page", ["https://example.com/"], false],
    ["origin not first", ["--parent-window=1", EXT], false],
    ["missing", [], false],
  ] as const)("%s", (_n, args, ok) => {
    expect(checkOrigin(args, config) !== undefined).toBe(ok);
  });

  test("config rejects wildcard or malformed origins", () => {
    expect(() =>
      parseHostConfig({ allowedOrigins: ["chrome-extension://*/"], socketPath: "x" }),
    ).toThrow();
    expect(() => parseHostConfig({ allowedOrigins: [EXT] })).toThrow();
    expect(parseHostConfig({ allowedOrigins: [EXT], socketPath: "x" }).allowedOrigins).toEqual([
      EXT,
    ]);
  });

  test("a wrong origin exits without connecting, reading or writing", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    stdin.write(writeRawFrame(Buffer.from(JSON.stringify({ type: "hello" })), true));
    let connected = false;
    const code = await runHost({
      args: [OTHER],
      config,
      stdin,
      stdout,
      connect: async () => {
        connected = true;
        throw new Error("must not connect");
      },
    });
    expect(code).not.toBe(0);
    expect(connected).toBe(false);
    expect(stdout.readableLength).toBe(0);
    expect(stdin.readableLength).toBeGreaterThan(0);
  });
});

/** The extension side of native messaging: native-endian length plus JSON. */
function nativePort(toHost: PassThrough, fromHost: PassThrough, tap: Buffer[]): MessageTransport {
  const q = new MessageQueue();
  const reader = new RawFrameReader({ maxFrameBytes: 1024 * 1024, littleEndian: true });
  fromHost.on("data", (c: Buffer) => {
    tap.push(c);
    for (const body of reader.push(c)) q.push(JSON.parse(body.toString("utf8")));
  });
  fromHost.on("end", () => q.close());
  return {
    send(m) {
      const frame = writeRawFrame(Buffer.from(JSON.stringify(m), "utf8"), true);
      tap.push(frame);
      toHost.write(frame);
    },
    receive: () => q.next(),
    close() {
      toHost.end();
      q.close();
    },
  };
}

describe("native messaging host relay", () => {
  async function start() {
    const dir = process.platform === "win32" ? "" : await mkdtemp(join(tmpdir(), "cs-h-"));
    const socketPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\citspark-host-${randomUUID().slice(0, 8)}`
        : join(dir, "ipc", "core.sock");
    const dialogs = new MessageQueue();
    const calls: unknown[] = [];
    const server = new IpcServer({
      staticKeyPair: generateStaticKeyPair(),
      coreVersion: "0.0.0-test",
      registry: new MemoryClientRegistry(),
      pairing: new PairingController({
        present: (_p, dialog) => {
          dialogs.push(dialog);
          return () => undefined;
        },
      }),
      handlers: {
        "capture.create": {
          scope: Scope.CaptureWrite,
          mutation: true,
          handle: async (payload) => {
            calls.push(payload);
            return { stored: payload };
          },
        },
      },
    });
    await server.listen(socketPath);
    cleanups.push(async () => {
      await server.close();
      if (dir) await rm(dir, { recursive: true, force: true });
    });
    const config: HostConfig = { allowedOrigins: [EXT], socketPath };
    const launch = (tap: Buffer[]) => {
      const stdin = new PassThrough();
      const stdout = new PassThrough();
      const exit = runHost({ args: [EXT], config, stdin, stdout, connect: connectIpc });
      return { port: nativePort(stdin, stdout, tap), exit, stdin };
    };
    return { launch, calls, nextDialog: () => dialogs.next() as Promise<PairingDialog> };
  }

  test("pairs and runs a request end to end while the host sees only ciphertext", async () => {
    const env = await start();
    const tap: Buffer[] = [];
    const identity = {
      kind: "extension" as const,
      version: "0.0.0-test",
      staticKeyPair: generateStaticKeyPair(),
    };
    let shown!: (c: string) => void;
    const code = new Promise<string>((r) => (shown = r));
    const h1 = env.launch(tap);
    const pairing = pairWithDesktop({
      transport: h1.port,
      identity,
      scopes: [Scope.CaptureWrite],
      showCode: shown,
    });
    const dialog = await env.nextDialog();
    const typed = await code;
    expect(dialog.submit(typed)).toBe("ok");
    const paired = await pairing;
    expect(await h1.exit).toBe(0);

    const h2 = env.launch(tap);
    const s = await connectSession({
      transport: h2.port,
      identity,
      desktopPublicKey: paired.desktopPublicKey,
    });
    await expect(s.request("capture.create", { MARKER }, { mutation: true })).resolves.toEqual({
      stored: { MARKER },
    });
    s.close();
    expect(await h2.exit).toBe(0);
    expect(env.calls).toEqual([{ MARKER }]);
    const wire = Buffer.concat(tap).toString("latin1");
    expect(wire).not.toContain(MARKER);
    expect(wire).not.toContain("capture.create");
    expect(wire).not.toContain(typed);
  });

  test("an oversized frame from the extension stops the relay", async () => {
    const env = await start();
    const h = env.launch([]);
    const header = Buffer.alloc(4);
    header.writeUInt32LE(TO_CORE_MAX_BYTES + 1);
    h.stdin.write(header);
    expect(await h.exit).not.toBe(0);
  });
});
