// Setup and teardown for the owner live-acceptance kit (M1-08, B8). Installs only into a dedicated
// browser profile and kit directory, records exactly what it created in `state.json`, and removes
// only that. Writes no key, cookie, token or credential; the host manifest lists the one extension
// origin (ADR 0006, no wildcards).
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";
import {
  hostManifestDir,
  installNativeHost,
  realRegRunner,
  uninstallNativeHost,
  type RegRunner,
} from "@citspark/native-host";
import { EXTENSION_ID } from "../../src/identity.ts";
import {
  assertDedicatedProfile,
  assertKitOutsideRepo,
  assertSocketPathFits,
  browserExecutable,
  launchCommand,
  layout,
  MARKER,
  type Env,
  type KitBrowser,
  type KitLayout,
} from "./paths.ts";

export interface KitState {
  version: 1;
  browser: KitBrowser;
  platform: NodeJS.Platform;
  createdAt: string;
  layout: KitLayout;
  extensionId: string;
  /** True when setup created the profile directory (so `--purge` may remove it). */
  createdProfile: boolean;
  manifestPath: string;
  launcherPath: string;
  configPath: string;
  manifestDir: string;
  registryKey: string | null;
}

export type { RegRunner };

export interface SetupDeps {
  env: Env;
  repoRoot: string;
  nodePath: string;
  now: () => Date;
  /** Builds the extension; returns the unpacked `dist` directory. */
  buildExtension: () => string;
  /** Bundles the native host into a file that does not live under a protected folder. */
  bundleHost: (outfile: string) => Promise<void>;
  reg: RegRunner;
  exists: (p: string) => boolean;
}

export function defaultDeps(repoRoot: string, env: Env): SetupDeps {
  return {
    env,
    repoRoot,
    nodePath: process.execPath,
    now: () => new Date(),
    exists: existsSync,
    reg: realRegRunner,
    buildExtension: () => {
      const run = (a: string[]) =>
        execFileSync("pnpm", a, {
          cwd: repoRoot,
          stdio: "inherit",
          shell: env.platform === "win32",
        });
      run(["build"]);
      run(["--filter", "@citspark/extension", "build"]);
      return join(repoRoot, "apps", "extension", "dist");
    },
    bundleHost: async (outfile) => {
      await build({
        entryPoints: [join(repoRoot, "packages", "native-host", "src", "cli.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        outfile,
        logLevel: "warning",
      });
    },
  };
}

export interface SetupOptions {
  browser: KitBrowser;
  kitDir?: string;
  profileDir?: string;
}

export interface SetupResult {
  state: KitState;
  executable: string | null;
  launch: string | null;
  instructions: string[];
}

function ownsOrEmpty(dir: string): boolean {
  if (!existsSync(dir)) return true;
  if (existsSync(join(dir, MARKER))) return true;
  return readdirSync(dir).length === 0;
}

export async function setup(o: SetupOptions, d: SetupDeps): Promise<SetupResult> {
  const l = layout({
    browser: o.browser,
    env: d.env,
    ...(o.kitDir ? { kitDir: o.kitDir } : {}),
    ...(o.profileDir ? { profileDir: o.profileDir } : {}),
  });
  assertKitOutsideRepo(d.env, l.browserDir, d.repoRoot);
  assertDedicatedProfile({
    browser: o.browser,
    env: d.env,
    profileDir: l.profileDir,
    repoRoot: d.repoRoot,
  });
  assertSocketPathFits(l.socketPath, d.env.platform);
  if (!ownsOrEmpty(l.profileDir)) {
    throw new Error(
      `${l.profileDir} exists and was not created by the live kit; choose an empty or new --profile-dir`,
    );
  }
  if (existsSync(l.statePath)) {
    throw new Error(`the kit is already set up for ${o.browser}; run live-kit:teardown first`);
  }

  const dist = d.buildExtension();
  const createdProfile = !existsSync(l.profileDir);
  mkdirSync(l.profileDir, { recursive: true });
  writeFileSync(join(l.profileDir, MARKER), "created by citspark live-kit setup\n");
  mkdirSync(l.libraryDir, { recursive: true });
  mkdirSync(l.evidenceDir, { recursive: true });
  writeFileSync(join(l.browserDir, MARKER), "created by citspark live-kit setup\n");

  rmSync(l.extensionDir, { recursive: true, force: true });
  cpSync(dist, l.extensionDir, { recursive: true });

  mkdirSync(l.hostDir, { recursive: true });
  const hostCli = join(l.hostDir, "cli.mjs");
  await d.bundleHost(hostCli);

  let paths: { launcherPath: string; manifestPath: string; configPath: string };
  let manifestDir: string;
  let registryKey: string | null = null;
  const common = {
    extensionIds: [EXTENSION_ID],
    socketPath: l.socketPath,
    nodePath: d.nodePath,
    cliPath: hostCli,
    installDir: l.hostDir,
    platform: d.env.platform,
  };
  if (d.env.platform === "win32") {
    // The installer writes the .cmd launcher, the manifest and the HKCU registry key (ADR 0006).
    manifestDir = l.hostDir;
    const r = await installNativeHost({ ...common, browser: o.browser, reg: d.reg });
    registryKey = r.registryKey ?? null;
    paths = r;
  } else {
    manifestDir = hostManifestDir({
      browser: o.browser,
      platform: d.env.platform,
      home: d.env.home,
      userDataDir: l.profileDir,
    });
    paths = await installNativeHost({ ...common, manifestDir });
  }

  const state: KitState = {
    version: 1,
    browser: o.browser,
    platform: d.env.platform,
    createdAt: d.now().toISOString(),
    layout: l,
    extensionId: EXTENSION_ID,
    createdProfile,
    ...paths,
    manifestDir,
    registryKey,
  };
  writeFileSync(l.statePath, JSON.stringify(state, null, 2) + "\n");

  const executable = browserExecutable(o.browser, d.env, d.exists);
  const launch = executable ? launchCommand(executable, l.profileDir, d.env.platform) : null;
  return { state, executable, launch, instructions: instructions(state, launch) };
}

export function instructions(s: KitState, launch: string | null): string[] {
  const l = s.layout;
  const b = s.browser === "chrome" ? "Chrome" : "Edge";
  const ext = s.browser === "chrome" ? "chrome://extensions" : "edge://extensions";
  return [
    `Kit ready for ${b}. Nothing was changed in your normal ${b} profile.`,
    "",
    "1. Start the desktop core in its own terminal (leave it running):",
    "     pnpm live-kit:desktop --browser " + s.browser,
    `2. Start ${b} with the dedicated profile:`,
    launch
      ? `     pnpm live-kit:launch --browser ${s.browser}\n   or paste: ${launch}`
      : `     ${b} was not found in its usual place. Start it yourself with:\n     --user-data-dir="${l.profileDir}" --no-first-run`,
    `3. In that window open ${ext}, turn on Developer mode, Load unpacked, and pick:`,
    `     ${l.extensionDir}`,
    `   The extension ID must read ${s.extensionId}.`,
    "4. Follow docs/m1-08/live-acceptance.md. When done:",
    `     pnpm live-kit:evidence --browser ${s.browser}`,
    `     pnpm live-kit:teardown --browser ${s.browser}`,
  ];
}

export interface TeardownOptions {
  browser: KitBrowser;
  kitDir?: string;
  profileDir?: string;
  /** Also delete the profile (only if setup created it), library and evidence. */
  purge?: boolean;
}

/** Removes exactly what setup recorded. The profile and library are kept unless `purge` is set. */
export async function teardown(o: TeardownOptions, d: SetupDeps): Promise<string[]> {
  const l = layout({
    browser: o.browser,
    env: d.env,
    ...(o.kitDir ? { kitDir: o.kitDir } : {}),
    ...(o.profileDir ? { profileDir: o.profileDir } : {}),
  });
  if (!existsSync(l.statePath)) {
    // A plain teardown already ran: `--purge` may still delete the kit's own directory (marked).
    if (o.purge && existsSync(join(l.browserDir, MARKER))) {
      rmSync(l.browserDir, { recursive: true, force: true });
      return ["profile, library, evidence and transitions inside the kit directory"];
    }
    throw new Error(`no live kit state for ${o.browser} at ${l.statePath}`);
  }
  const s = JSON.parse(readFileSync(l.statePath, "utf8")) as KitState;
  if (s.version !== 1 || s.browser !== o.browser) throw new Error("unrecognised kit state");
  const done: string[] = [];
  // The installer removes the manifest, launcher, config and registry key, and only those that prove
  // they are ours; anything else of the same name is left and reported.
  const un = await uninstallNativeHost({
    installDir: s.layout.hostDir,
    manifestDir: s.manifestDir,
    platform: s.platform,
    browser: s.browser,
    reg: d.reg,
  });
  for (const r of un.removed) done.push(`removed ${r}`);
  for (const r of un.skipped) done.push(`left alone (not ours): ${r}`);
  rmSync(join(s.layout.hostDir, "cli.mjs"), { force: true });
  rmEmpty(s.layout.hostDir);
  if (s.platform !== "win32") rmEmpty(s.manifestDir);
  rmSync(s.layout.extensionDir, { recursive: true, force: true });
  done.push("unpacked extension copy");
  rmSync(s.layout.statePath, { force: true });
  done.push("kit state");
  if (o.purge) {
    // Only paths setup created, and only when each carries the kit's marker.
    if (s.createdProfile && existsSync(join(s.layout.profileDir, MARKER))) {
      rmSync(s.layout.profileDir, { recursive: true, force: true });
      done.push("browser profile");
    }
    if (existsSync(join(s.layout.browserDir, MARKER))) {
      rmSync(s.layout.browserDir, { recursive: true, force: true });
      done.push("library, evidence and transitions");
    }
  } else {
    done.push("kept: profile, library, evidence (use --purge to delete)");
  }
  return done;
}

function rmEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    /* absent or not empty: leave it */
  }
}
