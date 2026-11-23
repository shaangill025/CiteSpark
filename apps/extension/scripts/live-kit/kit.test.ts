// Setup and teardown path logic against a temporary HOME. Nothing here touches the real browser
// directories: `home` is a temp dir and the build and host bundle steps are stubbed.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { EXTENSION_ID } from "../../src/identity.ts";
import { WINDOWS_REGISTRY_KEY } from "@citspark/native-host";
import { defaultDeps, setup, teardown, type SetupDeps } from "./kit.ts";
import { MARKER, type Env } from "./paths.ts";

// A Unix socket path must stay under ~100 bytes, and macOS TMPDIR paths are long: use /tmp when present.
const shortTmp = () => (existsSync("/tmp") ? "/tmp" : tmpdir());
const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function fixture(
  platform: NodeJS.Platform = process.platform === "win32" ? "linux" : process.platform,
) {
  const home = mkdtempSync(join(shortTmp(), "cs-lk-"));
  temps.push(home);
  const dist = join(home, "fake-dist");
  mkdirSync(dist);
  writeFileSync(join(dist, "manifest.json"), "{}");
  const regCalls: string[][] = [];
  const env: Env = { platform, home, env: {} };
  const deps: SetupDeps = {
    ...defaultDeps(join(home, "repo"), env),
    nodePath: "/usr/bin/node",
    now: () => new Date("2026-01-01T00:00:00Z"),
    buildExtension: () => dist,
    bundleHost: async (out) => writeFileSync(out, "// host"),
    reg: (a) => {
      regCalls.push(a);
      return a[0] === "query" ? `    (Default)    REG_SZ    ${manifestPathRef.v}\n` : "";
    },
    exists: () => true,
  };
  const manifestPathRef = { v: "" };
  return { home, deps, regCalls, manifestPathRef };
}

const real = (home: string) => [
  join(home, "Library", "Application Support", "Google", "Chrome"),
  join(home, "Library", "Application Support", "Microsoft Edge"),
  join(home, ".config", "google-chrome"),
  join(home, ".config", "microsoft-edge"),
];

describe.each(["chrome", "edge"] as const)("setup and teardown (%s)", (browser) => {
  test("installs only inside the kit, with the exact extension origin, and removes only that", async () => {
    const f = fixture("darwin");
    const r = await setup({ browser }, f.deps);
    const kit = join(f.home, ".citspark-live-kit", browser);
    expect(r.state.layout.profileDir).toBe(join(kit, "profile"));
    const manifestPath = join(
      kit,
      "profile",
      "NativeMessagingHosts",
      "com.citspark.native_host.json",
    );
    expect(r.state.manifestPath).toBe(manifestPath);
    const m = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    expect(m["allowed_origins"]).toEqual([`chrome-extension://${EXTENSION_ID}/`]);
    expect(m["name"]).toBe("com.citspark.native_host");
    expect(existsSync(m["path"] as string)).toBe(true);
    const cfg = JSON.parse(readFileSync(join(kit, "host", "native-host.json"), "utf8")) as {
      allowedOrigins: string[];
      socketPath: string;
    };
    expect(cfg.allowedOrigins).toEqual([`chrome-extension://${EXTENSION_ID}/`]);
    expect(cfg.socketPath).toBe(join(kit, "ipc", "core.sock"));
    expect(existsSync(join(kit, "extension", "manifest.json"))).toBe(true);
    // The real browser directories were never created.
    for (const d of real(f.home)) expect(existsSync(d)).toBe(false);
    expect(r.instructions.join("\n")).toContain(EXTENSION_ID);
    expect(r.launch).toContain(`--user-data-dir='${join(kit, "profile")}'`);

    const done = await teardown({ browser }, f.deps);
    expect(done.join("\n")).toMatch(/kept: profile/);
    expect(existsSync(manifestPath)).toBe(false);
    expect(existsSync(join(kit, "host"))).toBe(false);
    expect(existsSync(join(kit, "extension"))).toBe(false);
    expect(existsSync(join(kit, "state.json"))).toBe(false);
    // Profile and library survive a plain teardown.
    expect(existsSync(join(kit, "profile", MARKER))).toBe(true);
    expect(existsSync(join(kit, "library"))).toBe(true);
    for (const d of real(f.home)) expect(existsSync(d)).toBe(false);
  });

  test("--purge after a plain teardown still removes the kit directory, only when marked", async () => {
    const f = fixture("linux");
    await setup({ browser }, f.deps);
    await teardown({ browser }, f.deps);
    await teardown({ browser, purge: true }, f.deps);
    expect(existsSync(join(f.home, ".citspark-live-kit", browser))).toBe(false);
    mkdirSync(join(f.home, ".citspark-live-kit", browser), { recursive: true });
    await expect(teardown({ browser, purge: true }, f.deps)).rejects.toThrow(/no live kit state/);
  });

  test("--purge removes the kit's own profile and library, never a pre-existing profile dir", async () => {
    const f = fixture("linux");
    await setup({ browser }, f.deps);
    await teardown({ browser, purge: true }, f.deps);
    expect(existsSync(join(f.home, ".citspark-live-kit", browser))).toBe(false);

    // A user-supplied, pre-existing but empty profile dir is not deleted by purge.
    const own = join(f.home, "mine");
    mkdirSync(own);
    await setup({ browser, profileDir: own }, f.deps);
    expect(existsSync(join(own, "NativeMessagingHosts", "com.citspark.native_host.json"))).toBe(
      true,
    );
    await teardown({ browser, profileDir: own, purge: true }, f.deps);
    expect(existsSync(own)).toBe(true);
    expect(existsSync(join(own, "NativeMessagingHosts"))).toBe(false);
  });
});

describe("setup refusals", () => {
  test("refuses the real browser profile and a non-empty foreign directory", async () => {
    const f = fixture("darwin");
    const realChrome = join(f.home, "Library", "Application Support", "Google", "Chrome");
    await expect(setup({ browser: "chrome", profileDir: realChrome }, f.deps)).rejects.toThrow(
      /real chrome/,
    );
    expect(existsSync(realChrome)).toBe(false);
    const foreign = join(f.home, "foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "Preferences"), "{}");
    await expect(setup({ browser: "chrome", profileDir: foreign }, f.deps)).rejects.toThrow(
      /not created by the live kit/,
    );
  });
  test("refuses a second setup, and teardown without state", async () => {
    const f = fixture("linux");
    await expect(teardown({ browser: "chrome" }, f.deps)).rejects.toThrow(/no live kit state/);
    await setup({ browser: "chrome" }, f.deps);
    await expect(setup({ browser: "chrome" }, f.deps)).rejects.toThrow(/already set up/);
  });
  test("a kit directory inside the repository is refused", async () => {
    const f = fixture("linux");
    await expect(
      setup({ browser: "chrome", kitDir: join(f.home, "repo", "kit") }, f.deps),
    ).rejects.toThrow(/outside the repository/);
  });
  test("chrome and edge kits are independent", async () => {
    const f = fixture("linux");
    await setup({ browser: "chrome" }, f.deps);
    await setup({ browser: "edge" }, f.deps);
    await teardown({ browser: "chrome" }, f.deps);
    expect(readdirSync(join(f.home, ".citspark-live-kit", "edge", "host")).length).toBeGreaterThan(
      0,
    );
  });
});

describe("Windows registration", () => {
  test("lives in the native-host installer (reg.exe via an injected runner, HKCU only); see install.test.ts", () => {
    // Windows paths cannot be created on this OS, so the kit delegates and the installer's own
    // tests cover the .cmd launcher, per-browser HKCU keys, ownership checks and removal.
    // Real Windows execution is unverified locally; CI's windows runner runs the unit tests.
    expect(WINDOWS_REGISTRY_KEY.edge).toBe(
      "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.citspark.native_host",
    );
    expect(WINDOWS_REGISTRY_KEY.chrome).toBe(
      "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.citspark.native_host",
    );
  });
});
