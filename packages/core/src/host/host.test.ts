import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS, migrate } from "@citspark/store";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CoreStartError,
  LIBRARY_FILE,
  UI_PROTOCOL_LIMITS,
  runCoreHost,
  startDesktopCore,
  type DesktopCore,
  type HostPort,
} from "./index.ts";

const LATEST = Math.max(...MIGRATIONS.map((m) => m.version));

let dir: string;
let core: DesktopCore | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "citspark-host-"));
});
afterEach(() => {
  core?.close();
  core = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const hello = (versions = { min: 1, max: 1 }) => ({ type: "ui.hello", versions });
const req = (id: string, method: string, payload: unknown = null, mutation = false) => ({
  v: 1,
  id,
  method,
  mutation,
  payload,
});

async function ready(): Promise<DesktopCore> {
  core = await startDesktopCore({ dataDir: dir, coreVersion: "0.0.0-test" });
  return core;
}

describe("startDesktopCore", () => {
  it("creates and migrates the library in the given data directory", async () => {
    const c = await ready();
    expect(c.status().library.schemaVersion).toBe(LATEST);
    const db = new Database(join(dir, LIBRARY_FILE), { readonly: true });
    expect(db.prepare("SELECT max(version) v FROM schema_migration").get()).toEqual({ v: LATEST });
    db.close();
  });

  it("reopens an up-to-date library without migrating again", async () => {
    (await ready()).close();
    core = undefined;
    const c = await ready();
    expect(c.status().library).toMatchObject({ schemaVersion: LATEST, created: false });
  });

  it("refuses a relative data directory", async () => {
    await expect(
      startDesktopCore({ dataDir: "relative/dir", coreVersion: "x" }),
    ).rejects.toMatchObject({
      code: "data_dir_invalid",
    });
  });

  it("fails honestly on a file that is not a library", async () => {
    writeFileSync(join(dir, LIBRARY_FILE), "this is not sqlite".repeat(100));
    const err = await startDesktopCore({ dataDir: dir, coreVersion: "x" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CoreStartError);
    expect(err).toMatchObject({ code: "library_unreadable" });
  });

  it("refuses a library written by a newer build", async () => {
    const db = new Database(join(dir, LIBRARY_FILE));
    migrate(db);
    db.prepare("INSERT INTO schema_migration (version, name) VALUES (?, ?)").run(
      LATEST + 1,
      "future",
    );
    db.close();
    await expect(startDesktopCore({ dataDir: dir, coreVersion: "x" })).rejects.toMatchObject({
      code: "library_newer",
    });
  });

  it("refuses to migrate an older library without a backup (M2-08)", async () => {
    const db = new Database(join(dir, LIBRARY_FILE));
    migrate(db, { migrations: MIGRATIONS.slice(0, 1) });
    db.close();
    await expect(startDesktopCore({ dataDir: dir, coreVersion: "x" })).rejects.toMatchObject({
      code: "library_needs_backup",
    });
    const after = new Database(join(dir, LIBRARY_FILE), { readonly: true });
    expect(after.prepare("SELECT max(version) v FROM schema_migration").get()).toEqual({ v: 1 });
    after.close();
  });
});

describe("desktop-ui channel", () => {
  it("negotiates the protocol version before any request", async () => {
    const c = await ready();
    expect(await c.handle(req("1", "core.status"))).toMatchObject({
      id: "1",
      ok: false,
      error: { code: "unauthorized" },
    });
    expect(await c.handle(hello())).toEqual({
      type: "ui.hello.ok",
      version: 1,
      core: { version: "0.0.0-test" },
    });
  });

  it("reports an incompatible renderer instead of guessing", async () => {
    const c = await ready();
    expect(await c.handle(hello({ min: 2, max: 3 }))).toMatchObject({
      type: "ui.hello.error",
      error: { code: "incompatible" },
    });
    expect(await c.handle(req("1", "core.status"))).toMatchObject({ ok: false });
  });

  it("answers core.status from the running core", async () => {
    const c = await ready();
    await c.handle(hello());
    const res = (await c.handle(req("s", "core.status"))) as {
      ok: true;
      result: Record<string, unknown>;
    };
    expect(res).toMatchObject({ v: 1, id: "s", ok: true });
    expect(res.result).toMatchObject({
      state: "ready",
      core: { version: "0.0.0-test", pid: process.pid },
      protocol: { version: 1 },
      library: { schemaVersion: LATEST },
    });
    expect(typeof (res.result.memory as { rssBytes: number }).rssBytes).toBe("number");
  });

  it("rejects unknown methods, wrong mutation flags and wrong versions", async () => {
    const c = await ready();
    await c.handle(hello());
    expect(await c.handle(req("a", "library.delete", null, true))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
    expect(await c.handle(req("b", "core.status", null, true))).toMatchObject({
      ok: false,
      error: { code: "invalid_message" },
    });
    expect(await c.handle({ ...req("c", "core.status"), v: 2 })).toMatchObject({
      ok: false,
      error: { code: "incompatible" },
    });
    expect(await c.handle(req("d", "__proto__"))).toMatchObject({
      ok: false,
      error: { code: "not_found" },
    });
  });

  it("rejects malformed and oversized messages", async () => {
    const c = await ready();
    await c.handle(hello());
    expect(await c.handle({ id: "x", method: 3 })).toMatchObject({
      id: "x",
      ok: false,
      error: { code: "invalid_message" },
    });
    expect(await c.handle("not an object")).toMatchObject({ ok: false });
    const big = "x".repeat(UI_PROTOCOL_LIMITS.maxMessageBytes);
    expect(await c.handle(req("big", "core.status", big))).toMatchObject({
      id: "big",
      ok: false,
      error: { code: "frame_too_large" },
    });
  });
});

describe("runCoreHost", () => {
  function pair() {
    const sent: unknown[] = [];
    let deliver: (data: unknown) => void = () => undefined;
    const port: HostPort = {
      onMessage: (cb) => void (deliver = cb),
      post: (data) => void sent.push(data),
    };
    return { port, sent, deliver: (d: unknown) => deliver(d) };
  }
  const settle = () => new Promise((r) => setTimeout(r, 20));

  it("announces ready, serves requests and stops on shutdown", async () => {
    const { port, sent, deliver } = pair();
    const host = runCoreHost(port, { dataDir: dir, coreVersion: "1.2.3" });
    await host.started;
    expect(sent[0]).toMatchObject({ type: "core.ready", core: { version: "1.2.3" } });
    deliver({ type: "core.message", id: 7, body: hello() });
    await settle();
    expect(sent[1]).toMatchObject({ type: "core.reply", id: 7, body: { type: "ui.hello.ok" } });
    deliver({ type: "core.shutdown" });
    await host.stopped;
    expect(sent.at(-1)).toEqual({ type: "core.stopped" });
  });

  it("announces failure with a code and no stack or path", async () => {
    writeFileSync(join(dir, LIBRARY_FILE), "garbage".repeat(200));
    const { port, sent } = pair();
    const host = runCoreHost(port, { dataDir: dir, coreVersion: "1.2.3" });
    await host.started.catch(() => undefined);
    expect(sent[0]).toMatchObject({ type: "core.failed", error: { code: "library_unreadable" } });
    expect(JSON.stringify(sent[0])).not.toContain(dir);
  });

  it("ignores envelopes it does not know", async () => {
    mkdirSync(join(dir, "x"));
    const { port, sent, deliver } = pair();
    const host = runCoreHost(port, { dataDir: dir, coreVersion: "1" });
    await host.started;
    deliver({ type: "eval", code: "process.exit(1)" });
    deliver(null);
    await settle();
    expect(sent).toHaveLength(1);
    deliver({ type: "core.shutdown" });
    await host.stopped;
  });
});
