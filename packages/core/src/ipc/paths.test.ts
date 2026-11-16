import { spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { prepareListenPath } from "./paths.ts";

describe.skipIf(process.platform === "win32")("Unix socket path hardening (ADR 0006)", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cs-p-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("creates the socket directory with mode 0700", async () => {
    await prepareListenPath(join(dir, "ipc", "core.sock"));
    expect((await stat(join(dir, "ipc"))).mode & 0o777).toBe(0o700);
  });

  test("tightens a loose existing directory", async () => {
    await mkdir(join(dir, "ipc"), { mode: 0o755 });
    await prepareListenPath(join(dir, "ipc", "core.sock"));
    expect((await stat(join(dir, "ipc"))).mode & 0o777).toBe(0o700);
  });

  test("refuses a symlinked directory", async () => {
    await mkdir(join(dir, "real"));
    await symlink(join(dir, "real"), join(dir, "ipc"));
    await expect(prepareListenPath(join(dir, "ipc", "core.sock"))).rejects.toThrow(
      /not a directory/,
    );
  });

  test("refuses a regular file at the socket path", async () => {
    await mkdir(join(dir, "ipc"), { mode: 0o700 });
    await writeFile(join(dir, "ipc", "core.sock"), "x");
    await expect(prepareListenPath(join(dir, "ipc", "core.sock"))).rejects.toThrow(/not a socket/);
  });

  test("refuses to take over a live listener, and removes a stale socket", async () => {
    const path = join(dir, "ipc", "core.sock");
    await prepareListenPath(path);
    const live = createServer();
    await new Promise<void>((r) => live.listen(path, r));
    await expect(prepareListenPath(path)).rejects.toMatchObject({ code: "EADDRINUSE" });
    await new Promise<void>((r) => live.close(() => r()));
    // A crashed core leaves its socket file behind.
    const child = spawn(process.execPath, [
      "-e",
      `require("net").createServer().listen(${JSON.stringify(path)}, () => console.log("up"))`,
    ]);
    await new Promise((r) => child.stdout.once("data", r));
    child.kill("SIGKILL");
    await new Promise((r) => child.once("exit", r));
    expect((await lstat(path)).isSocket()).toBe(true);
    await prepareListenPath(path);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
