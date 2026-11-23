// Extension ↔ desktop link over a simulated native messaging port, against the real core IpcServer,
// pairing controller and capture handlers (ADR 0006, ADR 0011, M1-08). Synthetic data only.
import Database from "better-sqlite3";
import { describe, expect, test } from "vitest";
import {
  captureHandlers,
  IpcServer,
  MemoryClientRegistry,
  PairingController,
  type PairingDialog,
} from "@citspark/core";
import { generateStaticKeyPair, MessageQueue, type MessageTransport } from "@citspark/ipc";
import { CaptureMethod } from "@citspark/protocol";
import { migrate } from "@citspark/store";
import { DesktopLink, type PortLike } from "../src/background/link.ts";
import { PairingStore } from "../src/background/keystore.ts";
import { memoryKv } from "../src/background/pacer.ts";
import { SYNTH_ACCOUNT } from "./mock-x/bodies.ts";

interface Desktop {
  server: IpcServer;
  registry: MemoryClientRegistry;
  dialogs: PairingDialog[];
  calls: string[];
  /** Drop the next response record to the client and break the port, as a crash mid-reply would. */
  dropNextReply: boolean;
  open(): PortLike;
}

function desktop(): Desktop {
  const db = new Database(":memory:");
  migrate(db);
  const registry = new MemoryClientRegistry();
  const dialogs: PairingDialog[] = [];
  const calls: string[] = [];
  const handlers = captureHandlers({ db });
  const counted = Object.fromEntries(
    Object.entries(handlers).map(([m, h]) => [
      m,
      { ...h, handle: (p: never, c: never) => (calls.push(m), h.handle(p, c)) },
    ]),
  );
  const server = new IpcServer({
    staticKeyPair: generateStaticKeyPair(),
    coreVersion: "0.0.0-test",
    registry,
    pairing: new PairingController({ present: (_p, d) => (dialogs.push(d), () => undefined) }),
    handlers: counted,
  });
  const d: Desktop = {
    server,
    registry,
    dialogs,
    calls,
    dropNextReply: false,
    open() {
      const toServer = new MessageQueue();
      const listeners: ((m: unknown) => void)[] = [];
      const gone: (() => void)[] = [];
      let closed = false;
      let requests = 0;
      const close = () => {
        if (closed) return;
        closed = true;
        toServer.close();
        for (const g of gone) g();
      };
      const transport: MessageTransport = {
        send(m) {
          if (closed) return;
          const copy = JSON.parse(JSON.stringify(m)) as { type?: string };
          if (d.dropNextReply && copy.type === "rec" && requests > 0) {
            d.dropNextReply = false;
            close();
            return;
          }
          queueMicrotask(() => listeners.forEach((l) => l(copy)));
        },
        receive: () => toServer.next(),
        close,
      };
      void server.serve(transport);
      return {
        postMessage(m) {
          if (closed) throw new Error("Attempting to use a disconnected port object");
          if ((m as { type?: string }).type === "rec") requests++;
          toServer.push(JSON.parse(JSON.stringify(m)));
        },
        onMessage: { addListener: (l) => void listeners.push(l) },
        onDisconnect: { addListener: (l) => void gone.push(() => l()) },
        disconnect: close,
      };
    },
  };
  return d;
}

function deadPort(error: string): { open: () => PortLike; lastError: () => string } {
  return {
    lastError: () => error,
    open: () => {
      const gone: (() => void)[] = [];
      setTimeout(() => gone.forEach((g) => g()), 1);
      return {
        postMessage: () => undefined,
        onMessage: { addListener: () => undefined },
        onDisconnect: { addListener: (l) => void gone.push(() => l()) },
        disconnect: () => undefined,
      };
    },
  };
}

async function pair(d: Desktop, link: DesktopLink) {
  let shown = "";
  let typed!: (code: string) => void;
  const desktopCodeTyped = new Promise<string>((r) => (typed = r));
  const done = link.pair({
    showCode: (c) => {
      shown = c;
      queueMicrotask(async () => {
        await new Promise((r) => setTimeout(r, 5));
        const dialog = d.dialogs.at(-1)!;
        expect(dialog.submit(shown)).toBe("ok");
        typed(dialog.desktopCode()!);
      });
    },
    enterDesktopCode: () => desktopCodeTyped,
  });
  await done;
}

const start = {
  accountId: SYNTH_ACCOUNT,
  collection: "bookmarks",
  adapter: { id: "x-web", version: "1.0.0" },
};

describe("desktop link states (ADR 0006: clear unavailable and unpaired states)", () => {
  test("unpaired: reports not_paired without opening the native host", async () => {
    let opened = 0;
    const link = new DesktopLink({
      openPort: () => (opened++, desktop().open()),
      lastError: () => undefined,
      store: new PairingStore(memoryKv()),
      version: "0.1.0",
    });
    expect(await link.check()).toBe("not_paired");
    expect(opened).toBe(0);
  });

  test.each([
    ["Specified native messaging host not found.", "host_missing"],
    ["Native host has exited.", "desktop_unavailable"],
  ])("a port that closes with %j reports %s", async (error, state) => {
    const kv = memoryKv();
    const store = new PairingStore(kv);
    await store.save(generateStaticKeyPair(), {
      clientId: "c",
      desktopPublicKey: generateStaticKeyPair().publicKey,
    });
    const p = deadPort(error);
    const link = new DesktopLink({
      openPort: p.open,
      lastError: p.lastError,
      store,
      version: "0.1.0",
    });
    expect(await link.check()).toBe(state);
  });
});

describe("pairing and capture over the link", () => {
  test("mutual two-code pairing pins the desktop and enables capture.start", async () => {
    const d = desktop();
    const kv = memoryKv();
    const link = new DesktopLink({
      openPort: () => d.open(),
      lastError: () => undefined,
      store: new PairingStore(kv),
      version: "0.1.0",
    });
    await pair(d, link);
    expect(d.registry.list()).toHaveLength(1);
    expect(await link.check()).toBe("ready");
    const r = (await link.request(CaptureMethod.start, start, "req-1")) as { jobId: string };
    expect(r.jobId).toMatch(/^capture-/);
  });

  test("a revoked extension sees pairing_invalid, not a hang", async () => {
    const d = desktop();
    const link = new DesktopLink({
      openPort: () => d.open(),
      lastError: () => undefined,
      store: new PairingStore(memoryKv()),
      version: "0.1.0",
    });
    await pair(d, link);
    link.close();
    d.server.revoke(d.registry.list()[0]!.id);
    expect(await link.check()).toBe("pairing_invalid");
  });

  test("a lost desktop connection is reported, not left showing ready", async () => {
    const d = desktop();
    let opened = 0;
    let closedEvents = 0;
    const link = new DesktopLink({
      openPort: () => (opened++, d.open()),
      lastError: () => undefined,
      store: new PairingStore(memoryKv()),
      version: "0.1.0",
      onSessionClosed: () => void closedEvents++,
    });
    await pair(d, link);
    expect(await link.check()).toBe("ready");
    const before = opened;
    await d.server.close();
    await new Promise((r) => setTimeout(r, 20));
    // The owner must hear about it so the popup re-checks instead of keeping "Connected".
    expect(closedEvents).toBe(1);
    // And the next check opens a fresh port rather than trusting the dead session.
    await link.check();
    expect(opened).toBe(before + 1);
  });

  test("a reply lost with the connection is retried with the same request ID and runs once", async () => {
    const d = desktop();
    const link = new DesktopLink({
      openPort: () => d.open(),
      lastError: () => undefined,
      store: new PairingStore(memoryKv()),
      version: "0.1.0",
    });
    await pair(d, link);
    await link.check();
    d.dropNextReply = true;
    const r = (await link.request(CaptureMethod.start, start, "req-retry")) as { jobId: string };
    expect(r.jobId).toMatch(/^capture-/);
    expect(d.dropNextReply).toBe(false); // the reply really was lost once
    expect(d.calls.filter((c) => c === CaptureMethod.start)).toHaveLength(1);
  });
});
