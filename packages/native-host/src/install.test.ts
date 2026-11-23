import { lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  hostManifestDir,
  installNativeHost,
  NATIVE_HOST_NAME,
  NativeHostInstallError,
  uninstallNativeHost,
  WINDOWS_REGISTRY_KEY,
  type Browser,
} from "./install.ts";

const ID = "a".repeat(32);
const onWindows = process.platform === "win32";
// POSIX-only: these exercise the macOS/Linux flow against the real filesystem (a POSIX launcher with
// mode bits, symlinks that need no privilege). A Windows host runs the Windows-flow equivalents below.
const posixOnly = onWindows ? "POSIX filesystem semantics (mode bits, unprivileged symlinks)" : "";
const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), "cs-host-"));
  dirs.push(d);
  return d;
};

describe("native host manifest locations (ADR 0006)", () => {
  test.each([
    ["chrome", "darwin", "/h/Library/Application Support/Google/Chrome/NativeMessagingHosts"],
    ["edge", "darwin", "/h/Library/Application Support/Microsoft Edge/NativeMessagingHosts"],
    ["chromium", "darwin", "/h/Library/Application Support/Chromium/NativeMessagingHosts"],
    ["chrome", "linux", "/h/.config/google-chrome/NativeMessagingHosts"],
    ["edge", "linux", "/h/.config/microsoft-edge/NativeMessagingHosts"],
  ] as const)("%s on %s", (browser, platform, dir) => {
    expect(hostManifestDir({ browser, platform, home: "/h" })).toBe(dir);
  });

  test("an isolated browser profile keeps its hosts inside the profile", () => {
    expect(
      hostManifestDir({ browser: "chrome", platform: "darwin", home: "/h", userDataDir: "/p" }),
    ).toBe("/p/NativeMessagingHosts");
  });

  test("Windows needs registry keys and is refused here", () => {
    expect(() => hostManifestDir({ browser: "chrome", platform: "win32", home: "C:\\h" })).toThrow(
      /registry/,
    );
  });
});

describe("installing the host", () => {
  test.skipIf(onWindows)(
    "writes the config, an executable launcher, and a manifest listing exact origins",
    async () => {
      const install = await tmp();
      const manifests = await tmp();
      const r = await installNativeHost({
        extensionIds: [ID],
        socketPath: "/tmp/citspark/core.sock",
        nodePath: "/opt/node/bin/node",
        cliPath: "/opt/citspark/cli.js",
        installDir: install,
        manifestDir: manifests,
      });
      const manifest = JSON.parse(
        await readFile(join(manifests, `${NATIVE_HOST_NAME}.json`), "utf8"),
      );
      expect(manifest).toEqual({
        name: NATIVE_HOST_NAME,
        description: "Citspark desktop bridge for the Citspark capture extension",
        path: r.launcherPath,
        type: "stdio",
        allowed_origins: [`chrome-extension://${ID}/`],
      });
      const config = JSON.parse(await readFile(join(install, "native-host.json"), "utf8"));
      expect(config).toEqual({
        allowedOrigins: [`chrome-extension://${ID}/`],
        socketPath: "/tmp/citspark/core.sock",
      });
      const launcher = await readFile(r.launcherPath, "utf8");
      expect(launcher).toContain("exec '/opt/node/bin/node' '/opt/citspark/cli.js' \"$@\"");
      expect((await stat(r.launcherPath)).mode & 0o111).not.toBe(0);
      await uninstallNativeHost({ installDir: install, manifestDir: manifests });
      await expect(stat(join(manifests, `${NATIVE_HOST_NAME}.json`))).rejects.toThrow();
    },
  );

  test("refuses wildcard IDs and paths that would break the launcher quoting", async () => {
    const base = {
      socketPath: "/s",
      nodePath: "/n",
      cliPath: "/c",
      installDir: await tmp(),
      manifestDir: await tmp(),
    };
    await expect(installNativeHost({ ...base, extensionIds: ["*"] })).rejects.toThrow();
    await expect(
      installNativeHost({ ...base, extensionIds: [ID], nodePath: "/x'y" }),
    ).rejects.toThrow();
  });
});

describe("host config location", () => {
  test("the launcher's CITSPARK_HOST_CONFIG wins over the file beside the host", async () => {
    const { resolveConfigPath } = await import("./host.ts");
    // The host resolves paths with the OS it runs on, so the expectations use that OS's separator.
    const beside = join("/opt/h", "native-host.json");
    expect(resolveConfigPath({ CITSPARK_HOST_CONFIG: "/etc/c.json" }, "/opt/h")).toBe(
      "/etc/c.json",
    );
    expect(resolveConfigPath({}, "/opt/h")).toBe(beside);
    expect(resolveConfigPath({ CITSPARK_HOST_CONFIG: "relative.json" }, "/opt/h")).toBe(beside);
  });
});

const rejectsWith = async (p: Promise<unknown>, code: string) => {
  const e = await p.then(
    () => undefined,
    (err: unknown) => err,
  );
  expect(e).toBeInstanceOf(NativeHostInstallError);
  expect((e as NativeHostInstallError).code).toBe(code);
};

async function posixArgs() {
  return {
    extensionIds: [ID],
    socketPath: "/tmp/s.sock",
    nodePath: "/opt/node/bin/node",
    cliPath: "/opt/c/cli.js",
    installDir: await tmp(),
    manifestDir: await tmp(),
    platform: "linux" as NodeJS.Platform,
  };
}
const exists = (p: string) =>
  lstat(p).then(
    () => true,
    () => false,
  );

describe.skipIf(onWindows)(
  `installer safety (M1-08 review D4, ADR 0006) [skipped on Windows: ${posixOnly}]`,
  () => {
    test("unsupported browser or platform is a typed error, not a TypeError or a Linux fallthrough", () => {
      const bad = (o: object) => () => hostManifestDir({ home: "/h", ...o } as never);
      expect(bad({ browser: "brave", platform: "linux" })).toThrow(NativeHostInstallError);
      expect(bad({ browser: "chrome", platform: "freebsd" })).toThrow(/unsupported platform/);
      expect(bad({ browser: "chrome", platform: "freebsd" })).toThrow(NativeHostInstallError);
    });

    test("install refuses an unsupported browser (Windows) or platform with a typed error", async () => {
      const a = await posixArgs();
      await rejectsWith(installNativeHost({ ...a, platform: "freebsd" }), "unsupported_platform");
      await rejectsWith(
        installNativeHost({ ...a, platform: "win32", browser: "brave" as Browser, reg: () => "" }),
        "unsupported_browser",
      );
      await rejectsWith(installNativeHost({ ...a, manifestDir: undefined }), "missing_option");
    });

    test.each(["manifest", "launcher", "config"] as const)(
      "a symlink at the %s path is refused and its target is never written",
      async (which) => {
        const a = await posixArgs();
        const victim = join(await tmp(), "victim.txt");
        await writeFile(victim, "ORIGINAL");
        const name = {
          manifest: join(a.manifestDir, `${NATIVE_HOST_NAME}.json`),
          launcher: join(a.installDir, "citspark-native-host"),
          config: join(a.installDir, "native-host.json"),
        }[which];
        await symlink(victim, name);
        await rejectsWith(installNativeHost(a), "symlink_refused");
        expect(await readFile(victim, "utf8")).toBe("ORIGINAL");
        expect((await lstat(name)).isSymbolicLink()).toBe(true);
      },
    );

    test("another app's manifest with the same name is not overwritten, and nothing partial is left", async () => {
      const a = await posixArgs();
      const mp = join(a.manifestDir, `${NATIVE_HOST_NAME}.json`);
      const foreign = JSON.stringify({
        name: NATIVE_HOST_NAME,
        path: "/other/app/host",
        type: "stdio",
      });
      await writeFile(mp, foreign);
      await rejectsWith(installNativeHost(a), "not_ours");
      expect(await readFile(mp, "utf8")).toBe(foreign);
      expect(await readdir(a.installDir)).toEqual([]);
    });

    test("a foreign native-host.json in the install directory is not overwritten", async () => {
      const a = await posixArgs();
      await writeFile(join(a.installDir, "native-host.json"), '{"other":"app"}');
      await rejectsWith(installNativeHost(a), "not_ours");
      expect(await readFile(join(a.installDir, "native-host.json"), "utf8")).toBe(
        '{"other":"app"}',
      );
      expect(await readdir(a.manifestDir)).toEqual([]);
    });

    test("reinstalling over our own files (same or new install directory, new IDs) works and leaves no temp files", async () => {
      const a = await posixArgs();
      await installNativeHost(a);
      await installNativeHost({ ...a, extensionIds: ["p".repeat(32)] });
      const m = JSON.parse(await readFile(join(a.manifestDir, `${NATIVE_HOST_NAME}.json`), "utf8"));
      expect(m.allowed_origins).toEqual([`chrome-extension://${"p".repeat(32)}/`]);
      await installNativeHost({ ...a, installDir: await tmp() }); // moved: the old manifest is still ours
      expect(await readdir(a.installDir)).toEqual(["citspark-native-host", "native-host.json"]);
    });

    test("uninstall removes only files that prove they are ours", async () => {
      const a = await posixArgs();
      const mp = join(a.manifestDir, `${NATIVE_HOST_NAME}.json`);
      const foreign = JSON.stringify({ name: NATIVE_HOST_NAME, path: "/other/app/host" });
      await writeFile(mp, foreign);
      await writeFile(join(a.installDir, "native-host.json"), '{"other":"app config"}');
      const r = await uninstallNativeHost(a);
      expect(r.removed).toEqual([]);
      expect(r.skipped).toHaveLength(2);
      expect(await readFile(mp, "utf8")).toBe(foreign);
      expect(await readFile(join(a.installDir, "native-host.json"), "utf8")).toBe(
        '{"other":"app config"}',
      );
    });

    test("uninstall never deletes through or over a symlink, and removes ours when present", async () => {
      const a = await posixArgs();
      await installNativeHost(a);
      const mp = join(a.manifestDir, `${NATIVE_HOST_NAME}.json`);
      const real = await readFile(mp, "utf8");
      await rm(mp);
      const victim = join(await tmp(), "v.json");
      await writeFile(victim, real); // even content that looks ours, behind a symlink
      await symlink(victim, mp);
      const r = await uninstallNativeHost(a);
      expect(r.skipped).toContain(mp);
      expect((await lstat(mp)).isSymbolicLink()).toBe(true);
      expect(await readFile(victim, "utf8")).toBe(real);
      expect(r.removed).toHaveLength(2); // launcher and config were ours
      expect(await exists(join(a.installDir, "native-host.json"))).toBe(false);
      await rm(mp);
      expect(await readdir(a.manifestDir)).toEqual([]);
    });
  },
);

describe("Windows registry registration (reg.exe injected; real Windows execution is unverified here)", () => {
  function win(reg: (a: string[]) => string) {
    return async (browser: Browser = "chrome") => ({
      extensionIds: [ID],
      socketPath: "\\\\.\\pipe\\citspark",
      nodePath: "C:\\node\\node.exe",
      cliPath: "C:\\k\\cli.mjs",
      installDir: await tmp(),
      platform: "win32" as NodeJS.Platform,
      browser,
      reg,
    });
  }

  test.each(["chrome", "edge", "chromium"] as const)(
    "%s: writes a .cmd launcher and one HKCU key pointing at the manifest",
    async (browser) => {
      const calls: string[][] = [];
      const a = await win((c) => {
        calls.push(c);
        if (c[0] === "query") throw new Error("not found");
        return "";
      })(browser);
      const r = await installNativeHost(a);
      expect(r.launcherPath.endsWith("citspark-native-host.cmd")).toBe(true);
      const launcher = await readFile(r.launcherPath, "utf8");
      expect(launcher).toContain('"C:\\node\\node.exe" "C:\\k\\cli.mjs" %*');
      expect(launcher).toContain("CITSPARK_HOST_CONFIG=");
      const key = WINDOWS_REGISTRY_KEY[browser];
      expect(key.startsWith("HKCU\\")).toBe(true);
      expect(calls.at(-1)).toEqual(["add", key, "/ve", "/t", "REG_SZ", "/d", r.manifestPath, "/f"]);
      expect(calls.every((c) => c.every((x) => !x.startsWith("HKLM")))).toBe(true);
      const m = JSON.parse(await readFile(r.manifestPath, "utf8"));
      expect(m.path).toBe(r.launcherPath);
      expect(m.allowed_origins).toEqual([`chrome-extension://${ID}/`]);
    },
  );

  test("exact keys match ADR 0006's per-browser locations", () => {
    expect(WINDOWS_REGISTRY_KEY).toEqual({
      chrome: "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.citspark.native_host",
      edge: "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.citspark.native_host",
      chromium: "HKCU\\Software\\Chromium\\NativeMessagingHosts\\com.citspark.native_host",
    });
  });

  test("refuses to replace a registry key that points at another app's manifest", async () => {
    const other = join(await tmp(), "other.json");
    await writeFile(other, JSON.stringify({ name: NATIVE_HOST_NAME, path: "C:\\other\\host.exe" }));
    const calls: string[][] = [];
    const a = await win((c) => {
      calls.push(c);
      return c[0] === "query" ? `    (Default)    REG_SZ    ${other}\r\n` : "";
    })();
    await rejectsWith(installNativeHost(a), "not_ours");
    expect(calls.some((c) => c[0] === "add")).toBe(false);
    expect(await readdir(a.installDir)).toEqual([]);
  });

  test("uninstall deletes our key only, and leaves a foreign one alone", async () => {
    const calls: string[][] = [];
    let value = "";
    const a = await win((c) => {
      calls.push(c);
      if (c[0] === "query") {
        if (value === "") throw new Error("not found");
        return `    (Default)    REG_SZ    ${value}\r\n`;
      }
      return "";
    })("edge");
    const r = await installNativeHost(a);
    value = r.manifestPath;
    const done = await uninstallNativeHost(a);
    expect(done.removed).toContain(WINDOWS_REGISTRY_KEY.edge);
    expect(calls.at(-1)).toEqual(["delete", WINDOWS_REGISTRY_KEY.edge, "/f"]);

    calls.length = 0;
    value = "C:\\somebody\\else.json";
    const again = await uninstallNativeHost(a);
    expect(again.skipped).toContain(WINDOWS_REGISTRY_KEY.edge);
    expect(calls.some((c) => c[0] === "delete")).toBe(false);
  });

  test("a failed registry write is a typed error", async () => {
    const a = await win((c) => {
      if (c[0] === "add") throw new Error("access denied");
      throw new Error("not found");
    })();
    await rejectsWith(installNativeHost(a), "registry_failed");
  });

  test.skipIf(onWindows)("macOS and Linux never call reg", async () => {
    const calls: string[][] = [];
    const a = await posixArgs();
    await installNativeHost({ ...a, reg: (c) => (calls.push(c), "") });
    expect(calls).toEqual([]);
  });
});

// The Windows flow against the real filesystem (the manifest lives in the install directory; the
// registry is an injected runner). Runs on every OS; it is the only installer-safety coverage a
// Windows host gets for the file checks, so it mirrors the POSIX refusals that apply there.
describe("Windows install safety on the real filesystem", () => {
  const noKey = (c: string[]): string => {
    if (c[0] === "query") throw new Error("not found");
    return "";
  };
  const args = async () => ({
    extensionIds: [ID],
    socketPath: "\\\\.\\pipe\\citspark",
    nodePath: "C:\\node\\node.exe",
    cliPath: "C:\\k\\cli.mjs",
    installDir: await tmp(),
    platform: "win32" as NodeJS.Platform,
    browser: "chrome" as Browser,
    reg: noKey,
  });

  test("a foreign manifest or config with our file names is not overwritten", async () => {
    for (const name of [`${NATIVE_HOST_NAME}.json`, "native-host.json"]) {
      const a = await args();
      const foreign = JSON.stringify({ name: NATIVE_HOST_NAME, path: "C:\\other\\host.exe" });
      await writeFile(join(a.installDir, name), foreign);
      await rejectsWith(installNativeHost(a), "not_ours");
      expect(await readFile(join(a.installDir, name), "utf8")).toBe(foreign);
    }
  });

  test("reinstalling over our own files works, leaves no temp files, and uninstall removes them", async () => {
    const a = await args();
    await installNativeHost(a);
    await installNativeHost({ ...a, extensionIds: ["p".repeat(32)] });
    expect((await readdir(a.installDir)).sort()).toEqual([
      "citspark-native-host.cmd",
      `${NATIVE_HOST_NAME}.json`,
      "native-host.json",
    ]);
    const r = await uninstallNativeHost({ ...a, reg: () => "" });
    expect(r.removed).toHaveLength(3);
    expect(await readdir(a.installDir)).toEqual([]);
  });
});
