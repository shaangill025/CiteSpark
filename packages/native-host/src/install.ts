import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, posix, win32 } from "node:path";
import { parseHostConfig } from "./host.ts";

/** Host name the extension passes to `chrome.runtime.connectNative`. */
export const NATIVE_HOST_NAME = "com.citspark.native_host";
const LAUNCHER = "citspark-native-host";
const LAUNCHER_CMD = `${LAUNCHER}.cmd`;
const CONFIG = "native-host.json";
const DESCRIPTION = "Citspark desktop bridge for the Citspark capture extension";
const ID = /^[a-p]{32}$/;

export type Browser = "chrome" | "edge" | "chromium";
export const BROWSERS: readonly Browser[] = ["chrome", "edge", "chromium"];

export type InstallErrorCode =
  | "unsupported_browser"
  | "unsupported_platform"
  | "invalid_extension_id"
  | "unsafe_path"
  | "symlink_refused"
  | "not_ours"
  | "missing_option"
  | "registry_failed";

/** A refusal the caller can show as is; nothing was changed when the installer throws one. */
export class NativeHostInstallError extends Error {
  readonly code: InstallErrorCode;
  constructor(code: InstallErrorCode, message: string) {
    super(message);
    this.name = "NativeHostInstallError";
    this.code = code;
  }
}

const fail = (code: InstallErrorCode, message: string): never => {
  throw new NativeHostInstallError(code, message);
};

function assertBrowser(browser: unknown): asserts browser is Browser {
  if (!BROWSERS.includes(browser as Browser)) {
    fail(
      "unsupported_browser",
      `unsupported browser ${JSON.stringify(browser)}; supported: ${BROWSERS.join(", ")}`,
    );
  }
}

/** HKCU registry keys Chromium-based browsers read for native messaging hosts on Windows (ADR 0006). */
export const WINDOWS_REGISTRY_KEY: Record<Browser, string> = {
  chrome: `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  edge: `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
  chromium: `HKCU\\Software\\Chromium\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
};

/** Runs `reg.exe` with these arguments and returns stdout; throws when it exits non-zero. */
export type RegRunner = (args: string[]) => string;
export const realRegRunner: RegRunner = (args) =>
  execFileSync("reg", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

/**
 * Where a browser looks for user-level native messaging host manifests (ADR 0006). With
 * `userDataDir` (an isolated or custom profile) Chromium-based browsers read
 * `<userDataDir>/NativeMessagingHosts`. Windows has no manifest directory: it uses the registry keys
 * the installer writes (`WINDOWS_REGISTRY_KEY`).
 */
export function hostManifestDir(o: {
  browser: Browser;
  platform: NodeJS.Platform;
  home: string;
  userDataDir?: string;
}): string {
  assertBrowser(o.browser);
  if (o.platform === "win32") {
    return fail(
      "unsupported_platform",
      "Windows native messaging hosts are registered in the registry, not a manifest directory",
    );
  }
  if (o.platform !== "darwin" && o.platform !== "linux") {
    return fail(
      "unsupported_platform",
      `unsupported platform ${o.platform}; supported: macOS, Linux, Windows`,
    );
  }
  // macOS and Linux locations are POSIX paths whatever OS computes them: never the host's separator.
  if (o.userDataDir) return posix.join(o.userDataDir, "NativeMessagingHosts");
  const mac = {
    chrome: "Google/Chrome",
    edge: "Microsoft Edge",
    chromium: "Chromium",
  } as const;
  const linux = { chrome: "google-chrome", edge: "microsoft-edge", chromium: "chromium" } as const;
  return o.platform === "darwin"
    ? posix.join(o.home, "Library", "Application Support", mac[o.browser], "NativeMessagingHosts")
    : posix.join(o.home, ".config", linux[o.browser], "NativeMessagingHosts");
}

const shellSafe = (p: string, what: string, windows: boolean) => {
  const absolute = windows ? win32.isAbsolute(p) : posix.isAbsolute(p);
  const bad = windows ? /["%\r\n\0]/ : /['\n\r\0]/;
  if (!absolute || bad.test(p)) fail("unsafe_path", `unsafe ${what} path`);
  return p;
};

type Kind = "manifest" | "launcher" | "config";

interface Target {
  kind: Kind;
  path: string;
  content: string;
  mode: number;
}

/** Reads a file we may be about to replace; null when absent. Refuses symlinks and non-files. */
async function readExisting(path: string): Promise<string | null> {
  let st;
  try {
    st = await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  if (st.isSymbolicLink()) {
    fail("symlink_refused", `${path} is a symbolic link; refusing to touch it`);
  }
  if (!st.isFile()) fail("not_ours", `${path} is not a regular file; refusing to touch it`);
  return readFile(path, "utf8");
}

const parse = (text: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** A manifest is ours when it names this host, carries our description and points at our launcher. */
function manifestIsOurs(text: string, launcherPath?: string): boolean {
  const m = parse(text);
  if (!m || m["name"] !== NATIVE_HOST_NAME || m["description"] !== DESCRIPTION) return false;
  const p = m["path"];
  if (typeof p !== "string") return false;
  if (launcherPath !== undefined && p === launcherPath) return true;
  const base = p.split(/[\\/]/).pop();
  return base === LAUNCHER || base === LAUNCHER_CMD;
}

function launcherIsOurs(text: string): boolean {
  return /CITSPARK_HOST_CONFIG/.test(text) && /citspark/i.test(text);
}

function configIsOurs(text: string): boolean {
  const c = parse(text);
  if (!c) return false;
  try {
    parseHostConfig(c);
    return true;
  } catch {
    return false;
  }
}

const isOurs = (kind: Kind, text: string, launcherPath?: string): boolean =>
  kind === "manifest"
    ? manifestIsOurs(text, launcherPath)
    : kind === "launcher"
      ? launcherIsOurs(text)
      : configIsOurs(text);

/** Writes beside the target and renames over it, so a link or half-written file is never followed. */
async function writeAtomic(path: string, content: string, mode: number): Promise<void> {
  const tmp = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(tmp, content, { mode, flag: "wx" });
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true });
    throw e;
  }
}

const DEFAULT_REG_VALUE = /REG_SZ\s+(.+?)\s*$/m;

function registryValue(reg: RegRunner, key: string): string | null {
  let out: string;
  try {
    out = reg(["query", key, "/ve"]);
  } catch {
    return null; // the key does not exist
  }
  return DEFAULT_REG_VALUE.exec(out)?.[1] ?? null;
}

export interface InstallOptions {
  extensionIds: string[];
  socketPath: string;
  nodePath: string;
  cliPath: string;
  installDir: string;
  /** macOS and Linux: the browser's `NativeMessagingHosts` directory. Windows keeps it in `installDir`. */
  manifestDir?: string;
  /** Defaults to the running platform. */
  platform?: NodeJS.Platform;
  /** Windows: which browser's registry key to write (HKCU only). */
  browser?: Browser;
  /** Windows: runs `reg.exe`; injected in tests. */
  reg?: RegRunner;
}

export interface InstallResult {
  launcherPath: string;
  manifestPath: string;
  configPath: string;
  /** Windows: the registry key that now points at `manifestPath`. */
  registryKey?: string;
}

/**
 * Installs the host for one browser: the relay config (exact extension origins and the core socket),
 * a launcher that runs the host with an absolute Node path (browsers start hosts with a minimal
 * PATH), and the browser's host manifest (a file on macOS and Linux, an HKCU registry key on
 * Windows). Writes no key, token, or credential.
 *
 * It never follows a symbolic link at a path it writes, writes through a temporary file and rename,
 * and replaces a file only when that file's content proves Citspark wrote it; anything else is a
 * typed refusal before any change.
 */
export async function installNativeHost(o: InstallOptions): Promise<InstallResult> {
  const platform = o.platform ?? process.platform;
  const windows = platform === "win32";
  if (platform !== "darwin" && platform !== "linux" && !windows) {
    fail(
      "unsupported_platform",
      `unsupported platform ${platform}; supported: macOS, Linux, Windows`,
    );
  }
  if (o.extensionIds.length === 0 || !o.extensionIds.every((id) => ID.test(id))) {
    fail(
      "invalid_extension_id",
      "extension IDs must be exact 32-letter IDs; wildcards are not allowed",
    );
  }
  const reg = o.reg ?? realRegRunner;
  let registryKey: string | undefined;
  if (windows) {
    if (o.browser === undefined) {
      fail("missing_option", "Windows install needs a browser for its registry key");
    }
    assertBrowser(o.browser);
    registryKey = WINDOWS_REGISTRY_KEY[o.browser];
  } else if (o.manifestDir === undefined) {
    fail("missing_option", "manifestDir is required on macOS and Linux");
  }
  const origins = o.extensionIds.map((id) => `chrome-extension://${id}/`);
  const config = parseHostConfig({ allowedOrigins: origins, socketPath: o.socketPath });
  const node = shellSafe(o.nodePath, "node", windows);
  const cli = shellSafe(o.cliPath, "host", windows);
  const installDir = shellSafe(o.installDir, "install", windows);
  const manifestDir = windows ? installDir : (o.manifestDir as string);
  const configPath = join(installDir, CONFIG);
  const launcherPath = join(installDir, windows ? LAUNCHER_CMD : LAUNCHER);
  const manifestPath = join(manifestDir, `${NATIVE_HOST_NAME}.json`);
  const targets: Target[] = [
    {
      kind: "config",
      path: configPath,
      content: JSON.stringify(config, null, 2) + "\n",
      mode: 0o644,
    },
    {
      kind: "launcher",
      path: launcherPath,
      content: windows
        ? `@echo off\r\nrem citspark native messaging host launcher\r\nset "CITSPARK_HOST_CONFIG=${configPath}"\r\n"${node}" "${cli}" %*\r\n`
        : `#!/bin/sh\n# citspark native messaging host launcher\nCITSPARK_HOST_CONFIG='${configPath}'\nexport CITSPARK_HOST_CONFIG\nexec '${node}' '${cli}' "$@"\n`,
      mode: 0o755,
    },
    {
      kind: "manifest",
      path: manifestPath,
      content:
        JSON.stringify(
          {
            name: NATIVE_HOST_NAME,
            description: DESCRIPTION,
            path: launcherPath,
            type: "stdio",
            allowed_origins: origins,
          },
          null,
          2,
        ) + "\n",
      mode: 0o644,
    },
  ];

  await mkdir(installDir, { recursive: true });
  await mkdir(manifestDir, { recursive: true });
  // Check everything first so a refusal leaves no partial install behind.
  for (const t of targets) {
    const existing = await readExisting(t.path);
    if (existing !== null && !isOurs(t.kind, existing, launcherPath)) {
      fail(
        "not_ours",
        `${t.path} exists and was not written by Citspark; refusing to overwrite it`,
      );
    }
  }
  if (registryKey !== undefined) {
    const current = registryValue(reg, registryKey);
    if (current !== null && current !== manifestPath) {
      const text = await readExisting(current).catch(() => null);
      if (text === null || !manifestIsOurs(text)) {
        fail(
          "not_ours",
          `${registryKey} points at ${current}, which Citspark did not write; refusing to replace it`,
        );
      }
    }
  }
  for (const t of targets) await writeAtomic(t.path, t.content, t.mode);
  if (registryKey !== undefined) {
    try {
      reg(["add", registryKey, "/ve", "/t", "REG_SZ", "/d", manifestPath, "/f"]);
    } catch (e) {
      fail("registry_failed", `could not write ${registryKey}: ${(e as Error).message}`);
    }
    return { launcherPath, manifestPath, configPath, registryKey };
  }
  return { launcherPath, manifestPath, configPath };
}

export interface UninstallOptions {
  installDir: string;
  manifestDir?: string;
  platform?: NodeJS.Platform;
  browser?: Browser;
  reg?: RegRunner;
}

export interface UninstallResult {
  removed: string[];
  /** Present but not ours, a symbolic link, or not a regular file: left exactly as found. */
  skipped: string[];
}

/** Removes only what Citspark wrote; a same-name file or key that is not ours is left alone. */
export async function uninstallNativeHost(o: UninstallOptions): Promise<UninstallResult> {
  const platform = o.platform ?? process.platform;
  const windows = platform === "win32";
  const removed: string[] = [];
  const skipped: string[] = [];
  const manifestDir = windows ? o.installDir : o.manifestDir;
  if (manifestDir === undefined) {
    fail("missing_option", "manifestDir is required on macOS and Linux");
  }
  const launcherPath = join(o.installDir, windows ? LAUNCHER_CMD : LAUNCHER);
  const manifestPath = join(manifestDir as string, `${NATIVE_HOST_NAME}.json`);

  const drop = async (kind: Kind, path: string) => {
    let text: string | null;
    try {
      text = await readExisting(path);
    } catch (e) {
      if (e instanceof NativeHostInstallError) {
        skipped.push(path);
        return;
      }
      throw e;
    }
    if (text === null) return;
    if (!isOurs(kind, text, launcherPath)) {
      skipped.push(path);
      return;
    }
    await rm(path, { force: true });
    removed.push(path);
  };

  if (windows) {
    if (o.browser === undefined) {
      fail("missing_option", "Windows uninstall needs a browser for its registry key");
    }
    assertBrowser(o.browser);
    const key = WINDOWS_REGISTRY_KEY[o.browser];
    const reg = o.reg ?? realRegRunner;
    const current = registryValue(reg, key);
    if (current !== null) {
      const text = await readExisting(current).catch(() => null);
      if (text === null ? current === manifestPath : manifestIsOurs(text)) {
        try {
          reg(["delete", key, "/f"]);
          removed.push(key);
        } catch (e) {
          fail("registry_failed", `could not delete ${key}: ${(e as Error).message}`);
        }
      } else {
        skipped.push(key);
      }
    }
  }
  await drop("manifest", manifestPath);
  await drop("launcher", launcherPath);
  await drop("config", join(o.installDir, CONFIG));
  return { removed, skipped };
}
