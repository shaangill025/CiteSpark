// Path and launch logic for the owner live-acceptance kit (M1-08, B8). Pure functions: every
// platform, home and environment input is a parameter, so tests never touch a real browser directory.
import { homedir } from "node:os";
import { isAbsolute, posix, win32 } from "node:path";

export type KitBrowser = "chrome" | "edge";
export const KIT_BROWSERS: readonly KitBrowser[] = ["chrome", "edge"];
export const MARKER = ".citspark-live-kit";

export interface Env {
  platform: NodeJS.Platform;
  home: string;
  env: Record<string, string | undefined>;
}

export const realEnv = (): Env => ({
  platform: process.platform,
  home: homedir(),
  env: process.env,
});

export function parseBrowser(v: string | undefined): KitBrowser {
  if (v === "chrome" || v === "edge") return v;
  throw new Error("--browser must be chrome or edge");
}

const pathApi = (e: Env) => (e.platform === "win32" ? win32 : posix);

/** Root of everything the kit creates. Outside the repo; never a browser's real data directory. */
export function defaultKitDir(e: Env): string {
  return pathApi(e).join(e.home, ".citspark-live-kit");
}

/** A browser's normal (real) user-data directory: the kit must never use or write into it. */
export function realUserDataDir(browser: KitBrowser, e: Env): string {
  const p = pathApi(e);
  if (e.platform === "win32") {
    const local = e.env["LOCALAPPDATA"] ?? p.join(e.home, "AppData", "Local");
    return browser === "chrome"
      ? p.join(local, "Google", "Chrome", "User Data")
      : p.join(local, "Microsoft", "Edge", "User Data");
  }
  if (e.platform === "darwin") {
    return p.join(
      e.home,
      "Library",
      "Application Support",
      browser === "chrome" ? "Google/Chrome" : "Microsoft Edge",
    );
  }
  return p.join(e.home, ".config", browser === "chrome" ? "google-chrome" : "microsoft-edge");
}

export interface KitLayout {
  browserDir: string;
  profileDir: string;
  hostDir: string;
  extensionDir: string;
  libraryDir: string;
  libraryPath: string;
  statePath: string;
  transitionsPath: string;
  evidenceDir: string;
  /** Unix socket path, or a Windows named pipe. */
  socketPath: string;
}

export function layout(o: {
  browser: KitBrowser;
  env: Env;
  kitDir?: string;
  profileDir?: string;
}): KitLayout {
  const p = pathApi(o.env);
  const kit = p.resolve(o.kitDir ?? defaultKitDir(o.env));
  const browserDir = p.join(kit, o.browser);
  const socketPath =
    o.env.platform === "win32"
      ? `\\\\.\\pipe\\citspark-live-kit-${o.browser}-${tag(browserDir)}`
      : p.join(browserDir, "ipc", "core.sock");
  return {
    browserDir,
    profileDir: p.resolve(o.profileDir ?? p.join(browserDir, "profile")),
    hostDir: p.join(browserDir, "host"),
    extensionDir: p.join(browserDir, "extension"),
    libraryDir: p.join(browserDir, "library"),
    libraryPath: p.join(browserDir, "library", "library.sqlite"),
    statePath: p.join(browserDir, "state.json"),
    transitionsPath: p.join(browserDir, "transitions.jsonl"),
    evidenceDir: p.join(browserDir, "evidence"),
    socketPath,
  };
}

function tag(s: string): string {
  let h = 5381;
  for (const c of s) h = ((h << 5) + h + c.charCodeAt(0)) >>> 0;
  return h.toString(16);
}

/** macOS limits a Unix socket path to 103 bytes; refuse early instead of failing in `listen`. */
export function assertSocketPathFits(socketPath: string, platform: NodeJS.Platform): void {
  if (platform !== "win32" && Buffer.byteLength(socketPath) > 100) {
    throw new Error(
      `socket path is too long (${Buffer.byteLength(socketPath)} bytes, limit about 100): choose a shorter --dir`,
    );
  }
}

const inside = (e: Env, parent: string, child: string): boolean => {
  const r = pathApi(e).relative(parent, child);
  return r === "" || (!r.startsWith("..") && !isAbsolute(r) && !/^[A-Za-z]:/.test(r));
};

/**
 * The kit may only create a dedicated profile: never a browser's real data directory (or anything
 * inside it), never inside the repository, and only a path it can prove it owns (empty or marked).
 */
export function assertDedicatedProfile(o: {
  browser: KitBrowser;
  env: Env;
  profileDir: string;
  repoRoot: string;
}): void {
  const p = pathApi(o.env);
  const profile = p.resolve(o.profileDir);
  for (const b of KIT_BROWSERS) {
    const real = realUserDataDir(b, o.env);
    if (inside(o.env, real, profile) || inside(o.env, profile, real)) {
      throw new Error(`refusing to use ${profile}: it overlaps the real ${b} data directory`);
    }
  }
  if (inside(o.env, o.repoRoot, profile)) {
    throw new Error("the profile directory must be outside the repository");
  }
}

export function assertKitOutsideRepo(e: Env, kitDir: string, repoRoot: string): void {
  if (inside(e, repoRoot, pathApi(e).resolve(kitDir))) {
    throw new Error("the kit directory must be outside the repository");
  }
}

/** Where the browser binary normally lives; the first candidate that `exists` wins. */
export function browserExecutable(
  browser: KitBrowser,
  e: Env,
  exists: (p: string) => boolean,
): string | null {
  const c = executableCandidates(browser, e);
  return c.find(exists) ?? null;
}

export function executableCandidates(browser: KitBrowser, e: Env): string[] {
  if (e.platform === "darwin") {
    return browser === "chrome"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          posix.join(e.home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        ]
      : [
          "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          posix.join(e.home, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        ];
  }
  if (e.platform === "win32") {
    const pf = e.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = e.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = e.env["LOCALAPPDATA"] ?? win32.join(e.home, "AppData", "Local");
    const sub =
      browser === "chrome" ? ["Google", "Chrome", "Application", "chrome.exe"] : undefined;
    const edge = ["Microsoft", "Edge", "Application", "msedge.exe"];
    return [pf, pf86, local].map((r) => win32.join(r, ...(sub ?? edge)));
  }
  return browser === "chrome"
    ? ["/opt/google/chrome/chrome", "/usr/bin/google-chrome-stable", "/usr/bin/google-chrome"]
    : ["/opt/microsoft/msedge/msedge", "/usr/bin/microsoft-edge-stable", "/usr/bin/microsoft-edge"];
}

/** Flags that give the browser the dedicated profile. `--load-extension` is not used: see the doc. */
export function launchArgs(profileDir: string): string[] {
  return [`--user-data-dir=${profileDir}`, "--no-first-run", "--no-default-browser-check"];
}

const quote = (s: string, platform: NodeJS.Platform): string =>
  platform === "win32" ? `"${s}"` : `'${s.replace(/'/g, `'\\''`)}'`;

/** The exact command line the owner can paste, for the platform's own shell. */
export function launchCommand(exe: string, profileDir: string, platform: NodeJS.Platform): string {
  const args = launchArgs(profileDir).map((a) =>
    a.startsWith("--user-data-dir=") ? `--user-data-dir=${quote(profileDir, platform)}` : a,
  );
  return platform === "win32"
    ? `& "${exe}" ${args.join(" ")}`
    : `${quote(exe, platform)} ${args.join(" ")}`;
}
