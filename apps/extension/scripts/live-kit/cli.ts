// Owner live-acceptance kit CLI (M1-08, B8): setup | launch | desktop | evidence | teardown.
// See docs/m1-08/live-acceptance.md.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { buildEvidence, gitCommit, osInfo, writeEvidenceGated } from "./evidence.ts";
import { runDesktop } from "./desktop.ts";
import { defaultDeps, setup, teardown, type KitState } from "./kit.ts";
import { layout, parseBrowser, realEnv, browserExecutable, launchArgs } from "./paths.ts";

const repoRoot = resolve(import.meta.dirname, "..", "..", "..", "..");

interface Args {
  cmd: string;
  flags: Map<string, string[]>;
}

export function parseArgs(argv: string[]): Args {
  const [cmd = "", ...rest] = argv;
  const flags = new Map<string, string[]>();
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const [k, inline] = a.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    const boolean = ["purge", "help"].includes(k);
    const v = boolean ? "true" : (inline ?? rest[++i]);
    if (v === undefined) throw new Error(`--${k} needs a value`);
    flags.set(k, [...(flags.get(k) ?? []), v]);
  }
  return { cmd, flags };
}

const one = (a: Args, k: string): string | undefined => a.flags.get(k)?.at(-1);

function browserVersion(state: KitState): string | null {
  const env = realEnv();
  const exe = browserExecutable(state.browser, env, existsSync);
  if (!exe) return null;
  try {
    if (env.platform === "darwin") {
      const plist = readFileSync(join(exe, "..", "..", "Info.plist"), "utf8");
      return /CFBundleShortVersionString<\/key>\s*<string>([\d.]+)</.exec(plist)?.[1] ?? null;
    }
    if (env.platform === "win32") {
      const out = execFileSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `(Get-Item '${exe.replace(/'/g, "''")}').VersionInfo.ProductVersion`,
        ],
        { encoding: "utf8" },
      );
      return /^[\d.]+/.exec(out.trim())?.[0] ?? null;
    }
    return (
      /([\d]+(?:\.[\d]+){2,3})/.exec(execFileSync(exe, ["--version"], { encoding: "utf8" }))?.[1] ??
      null
    );
  } catch {
    return null;
  }
}

function loadState(a: Args): KitState {
  const browser = parseBrowser(one(a, "browser"));
  const l = layout({
    browser,
    env: realEnv(),
    ...(one(a, "dir") ? { kitDir: one(a, "dir")! } : {}),
    ...(one(a, "profile-dir") ? { profileDir: one(a, "profile-dir")! } : {}),
  });
  if (!existsSync(l.statePath)) throw new Error(`run live-kit:setup --browser ${browser} first`);
  return JSON.parse(readFileSync(l.statePath, "utf8")) as KitState;
}

async function main(): Promise<number> {
  const a = parseArgs(process.argv.slice(2));
  const env = realEnv();
  const common = {
    ...(one(a, "dir") ? { kitDir: one(a, "dir")! } : {}),
    ...(one(a, "profile-dir") ? { profileDir: one(a, "profile-dir")! } : {}),
  };
  switch (a.cmd) {
    case "setup": {
      const r = await setup(
        { browser: parseBrowser(one(a, "browser")), ...common },
        defaultDeps(repoRoot, env),
      );
      console.log(r.instructions.join("\n"));
      return 0;
    }
    case "teardown": {
      const done = await teardown(
        { browser: parseBrowser(one(a, "browser")), ...common, purge: a.flags.has("purge") },
        defaultDeps(repoRoot, env),
      );
      console.log("Removed:\n" + done.map((d) => `  - ${d}`).join("\n"));
      return 0;
    }
    case "launch": {
      const s = loadState(a);
      const exe = browserExecutable(s.browser, env, existsSync);
      if (!exe)
        throw new Error(
          `${s.browser} not found; start it yourself with --user-data-dir="${s.layout.profileDir}"`,
        );
      spawn(exe, launchArgs(s.layout.profileDir), { detached: true, stdio: "ignore" }).unref();
      console.log(`Started ${s.browser} with the dedicated profile ${s.layout.profileDir}`);
      return 0;
    }
    case "desktop": {
      await runDesktop(loadState(a).layout);
      return 0;
    }
    case "evidence": {
      const s = loadState(a);
      const l = s.layout;
      if (!existsSync(l.libraryPath)) throw new Error("no library yet: run a capture first");
      const pkg = JSON.parse(
        readFileSync(join(repoRoot, "apps", "extension", "package.json"), "utf8"),
      ) as { version: string };
      const evidence = buildEvidence({
        libraryPath: l.libraryPath,
        transitionsPath: l.transitionsPath,
        browser: {
          name: s.browser === "chrome" ? "Google Chrome" : "Microsoft Edge",
          version: one(a, "browser-version") ?? browserVersion(s),
        },
        extensionVersion: pkg.version,
        os: osInfo(env.platform),
        nodeVersion: process.version,
        commit: gitCommit(repoRoot),
        now: new Date(),
      });
      mkdirSync(l.evidenceDir, { recursive: true });
      const out =
        one(a, "out") ??
        join(l.evidenceDir, `evidence-${evidence.generatedAt.replace(/[:.]/g, "-")}.json`);
      const gate = writeEvidenceGated({
        evidence,
        outPath: out,
        scanPaths: [l.libraryDir, l.transitionsPath],
        canaries: a.flags.get("canary") ?? [],
      });
      if (!gate.ok) {
        console.error("REFUSED: evidence not written (credential or content shape found).");
        for (const p of gate.problems) console.error(`  shape: ${p}`);
        for (const f of gate.findings) console.error(`  scanner: ${f.file} ${f.match}`);
        return 2;
      }
      console.log(`Evidence written: ${out}`);
      console.log("Scanner: no credential material in the evidence file or the library directory.");
      return 0;
    }
    default:
      console.error(
        "usage: cli.ts setup|teardown|launch|desktop|evidence --browser chrome|edge [--dir D] [--profile-dir P]",
      );
      return 1;
  }
}

if (import.meta.main) {
  main().then(
    (c) => process.exit(c),
    (e: unknown) => {
      console.error(`live-kit: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(1);
    },
  );
}
