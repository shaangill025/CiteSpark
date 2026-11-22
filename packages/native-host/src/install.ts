import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseHostConfig } from "./host.ts";

/** Host name the extension passes to `chrome.runtime.connectNative`. */
export const NATIVE_HOST_NAME = "com.citspark.native_host";
const LAUNCHER = "citspark-native-host";
const ID = /^[a-p]{32}$/;

export type Browser = "chrome" | "edge" | "chromium";

/**
 * Where a browser looks for user-level native messaging host manifests (ADR 0006). With
 * `userDataDir` (an isolated or custom profile) Chromium-based browsers read
 * `<userDataDir>/NativeMessagingHosts`. Windows uses registry keys, which this installer does not
 * write yet; the desktop installer (M2-01) owns them.
 */
export function hostManifestDir(o: {
  browser: Browser;
  platform: NodeJS.Platform;
  home: string;
  userDataDir?: string;
}): string {
  if (o.platform === "win32") {
    throw new Error(
      "Windows native messaging hosts are registered in the registry (M2-01 installer)",
    );
  }
  if (o.userDataDir) return join(o.userDataDir, "NativeMessagingHosts");
  const mac = {
    chrome: "Google/Chrome",
    edge: "Microsoft Edge",
    chromium: "Chromium",
  } as const;
  const linux = { chrome: "google-chrome", edge: "microsoft-edge", chromium: "chromium" } as const;
  return o.platform === "darwin"
    ? join(o.home, "Library", "Application Support", mac[o.browser], "NativeMessagingHosts")
    : join(o.home, ".config", linux[o.browser], "NativeMessagingHosts");
}

const shellSafe = (p: string, what: string) => {
  if (!p.startsWith("/") || /['\n\r\0]/.test(p)) throw new Error(`unsafe ${what} path`);
  return p;
};

/**
 * Installs the host for one browser on macOS or Linux: the relay config (exact extension origins and
 * the core socket), a launcher that runs the host with an absolute Node path (browsers start hosts
 * with a minimal PATH), and the browser's host manifest. Writes no key, token, or credential.
 */
export async function installNativeHost(o: {
  extensionIds: string[];
  socketPath: string;
  nodePath: string;
  cliPath: string;
  installDir: string;
  manifestDir: string;
}): Promise<{ launcherPath: string; manifestPath: string; configPath: string }> {
  if (o.extensionIds.length === 0 || !o.extensionIds.every((id) => ID.test(id))) {
    throw new Error("extension IDs must be exact 32-letter IDs; wildcards are not allowed");
  }
  const origins = o.extensionIds.map((id) => `chrome-extension://${id}/`);
  const config = parseHostConfig({ allowedOrigins: origins, socketPath: o.socketPath });
  const node = shellSafe(o.nodePath, "node");
  const cli = shellSafe(o.cliPath, "host");
  const installDir = shellSafe(o.installDir, "install");
  await mkdir(installDir, { recursive: true });
  await mkdir(o.manifestDir, { recursive: true });
  const configPath = join(installDir, "native-host.json");
  const launcherPath = join(installDir, LAUNCHER);
  const manifestPath = join(o.manifestDir, `${NATIVE_HOST_NAME}.json`);
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n", { mode: 0o644 });
  await writeFile(
    launcherPath,
    `#!/bin/sh\nCITSPARK_HOST_CONFIG='${configPath}'\nexport CITSPARK_HOST_CONFIG\nexec '${node}' '${cli}' "$@"\n`,
    { mode: 0o755 },
  );
  await chmod(launcherPath, 0o755);
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        name: NATIVE_HOST_NAME,
        description: "Citspark desktop bridge for the Citspark capture extension",
        path: launcherPath,
        type: "stdio",
        allowed_origins: origins,
      },
      null,
      2,
    ) + "\n",
  );
  return { launcherPath, manifestPath, configPath };
}

export async function uninstallNativeHost(o: {
  installDir: string;
  manifestDir: string;
}): Promise<void> {
  await rm(join(o.manifestDir, `${NATIVE_HOST_NAME}.json`), { force: true });
  await rm(join(o.installDir, LAUNCHER), { force: true });
  await rm(join(o.installDir, "native-host.json"), { force: true });
}
