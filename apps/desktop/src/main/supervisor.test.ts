import { fork } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoreSupervisor,
  type CoreChild,
  type CoreState,
  type SupervisorOptions,
} from "./supervisor.ts";

// Real child processes running the real core (`@citspark/core/host`), adapted the way the app adapts
// Electron's utilityProcess. Modes in the fixture inject the failures the supervisor must survive.
const CHILD = fileURLToPath(new URL("./testing/node-core-child.mjs", import.meta.url));

type Mode = "normal" | "crash-on-start" | "never-ready" | "hang-on-shutdown";

function nodeChild(mode: Mode, dataDir: string): CoreChild {
  const child = fork(CHILD, [mode, dataDir], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
  return {
    pid: child.pid,
    post: (msg) => {
      if (child.connected) child.send(msg as never);
    },
    onMessage: (cb) => void child.on("message", cb),
    onExit: (cb) => void child.once("exit", (code) => cb(code)),
    kill: () => void child.kill("SIGKILL"),
  };
}

const alive = (pid: number | undefined) => {
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

let dir: string;
let sup: CoreSupervisor | undefined;
let states: CoreState[];
let spawned: CoreChild[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "citspark-sup-"));
  states = [];
  spawned = [];
});
afterEach(async () => {
  await sup?.stop();
  sup = undefined;
  rmSync(dir, { recursive: true, force: true });
});

function supervise(modes: Mode[] | Mode, over: Partial<SupervisorOptions> = {}): CoreSupervisor {
  const list = Array.isArray(modes) ? [...modes] : undefined;
  sup = new CoreSupervisor({
    spawn: () => {
      const mode = list ? (list.length > 1 ? list.shift()! : list[0]!) : (modes as Mode);
      const c = nodeChild(mode, dir);
      spawned.push(c);
      return c;
    },
    startTimeoutMs: 5000,
    stopGraceMs: 1000,
    maxRestarts: 2,
    restartWindowMs: 60_000,
    backoffMs: () => 20,
    onState: (s) => void states.push(s),
    onReply: () => undefined,
    ...over,
  });
  return sup;
}

const until = async (pred: () => boolean, ms = 10_000) => {
  const end = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > end) throw new Error(`timed out; states: ${JSON.stringify(states)}`);
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe("CoreSupervisor", () => {
  it("starts the core in a child process and relays protocol messages to it", async () => {
    const replies: [number, unknown][] = [];
    const s = supervise("normal", { onReply: (id, body) => void replies.push([id, body]) });
    s.start();
    expect(s.state.state).toBe("starting");
    await until(() => s.state.state === "ready");
    expect(s.state).toMatchObject({ state: "ready", pid: spawned[0]!.pid, schemaVersion: 7 });
    expect(s.send(1, { type: "ui.hello", versions: { min: 1, max: 1 } })).toBe(true);
    expect(
      s.send(2, { v: 1, id: "r", method: "core.status", mutation: false, payload: null }),
    ).toBe(true);
    await until(() => replies.length === 2);
    expect(replies[1]).toMatchObject([2, { ok: true, result: { core: { pid: spawned[0]!.pid } } }]);
  });

  it("survives an onReply that throws and keeps serving later replies", async () => {
    const got: number[] = [];
    const s = supervise("normal", {
      onReply: (id) => {
        got.push(id);
        if (id === 1) throw new Error("boom");
      },
    });
    s.start();
    await until(() => s.state.state === "ready");
    s.send(1, { v: 1, id: "a", method: "core.status", mutation: false, payload: null });
    s.send(2, { v: 1, id: "b", method: "core.status", mutation: false, payload: null });
    await until(() => got.length === 2);
    expect(s.state.state).toBe("ready");
  });

  it("restarts a core that crashes after it was ready", async () => {
    const s = supervise("normal");
    s.start();
    await until(() => s.state.state === "ready");
    const first = spawned[0]!.pid!;
    process.kill(first, "SIGKILL");
    await until(() => states.some((x) => x.state === "restarting"));
    await until(() => s.state.state === "ready" && spawned.length === 2);
    expect(alive(first)).toBe(false);
    expect((s.state as { pid: number }).pid).not.toBe(first);
  });

  it("gives up after a bounded number of crashes and stops spawning", async () => {
    const s = supervise("crash-on-start");
    s.start();
    await until(() => s.state.state === "failed");
    expect(s.state).toMatchObject({ state: "failed", code: "core_crashed" });
    expect(spawned).toHaveLength(3); // first start + maxRestarts
    await new Promise((r) => setTimeout(r, 200));
    expect(spawned).toHaveLength(3);
    expect(spawned.every((c) => !alive(c.pid))).toBe(true);
  });

  it("reports a core start failure as-is and does not retry it on its own", async () => {
    writeFileSync(join(dir, "library.sqlite"), "garbage".repeat(500));
    const s = supervise("normal");
    s.start();
    await until(() => s.state.state === "failed");
    expect(s.state).toMatchObject({ state: "failed", code: "library_unreadable" });
    await until(() => !alive(spawned[0]!.pid));
    expect(spawned).toHaveLength(1);
  });

  it("kills a core that does not become ready in time", async () => {
    const s = supervise("never-ready", { startTimeoutMs: 300, maxRestarts: 0 });
    s.start();
    await until(() => s.state.state === "failed");
    expect(s.state).toMatchObject({ code: "core_start_timeout" });
    await until(() => !alive(spawned[0]!.pid));
  });

  it("retries on request after a failure, with a fresh restart budget", async () => {
    const s = supervise(["crash-on-start", "normal"], { maxRestarts: 0 });
    s.start();
    await until(() => s.state.state === "failed");
    s.retry();
    await until(() => s.state.state === "ready");
    expect(spawned).toHaveLength(2);
  });

  it("refuses to relay while the core is not ready", () => {
    const s = supervise("never-ready");
    expect(s.send(1, {})).toBe(false);
    s.start();
    expect(s.send(1, {})).toBe(false);
  });

  it("stops gracefully and reaps the child", async () => {
    const s = supervise("normal");
    s.start();
    await until(() => s.state.state === "ready");
    const pid = spawned[0]!.pid;
    await s.stop();
    expect(s.state.state).toBe("stopped");
    expect(alive(pid)).toBe(false);
    expect(spawned).toHaveLength(1);
  });

  it("kills a child that ignores shutdown once the grace period ends", async () => {
    const s = supervise("hang-on-shutdown", { stopGraceMs: 200 });
    s.start();
    await until(() => s.state.state === "ready");
    const pid = spawned[0]!.pid;
    const t = Date.now();
    await s.stop();
    expect(Date.now() - t).toBeGreaterThanOrEqual(150);
    expect(alive(pid)).toBe(false);
  });
});
