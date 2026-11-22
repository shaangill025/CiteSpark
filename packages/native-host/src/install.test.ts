import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import {
  hostManifestDir,
  installNativeHost,
  NATIVE_HOST_NAME,
  uninstallNativeHost,
} from "./install.ts";

const ID = "a".repeat(32);
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
  test("writes the config, an executable launcher, and a manifest listing exact origins", async () => {
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
  });

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
    expect(resolveConfigPath({ CITSPARK_HOST_CONFIG: "/etc/c.json" }, "/opt/h")).toBe(
      "/etc/c.json",
    );
    expect(resolveConfigPath({}, "/opt/h")).toBe("/opt/h/native-host.json");
    expect(resolveConfigPath({ CITSPARK_HOST_CONFIG: "relative.json" }, "/opt/h")).toBe(
      "/opt/h/native-host.json",
    );
  });
});
