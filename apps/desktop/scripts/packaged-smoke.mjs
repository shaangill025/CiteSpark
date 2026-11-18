// Smoke test of the packaged app electron-builder produced (build/release/*-unpacked or *.app).
// It copies the packaged app out of the repository, launches it with an isolated synthetic userData
// directory and a clean environment, drives the renderer over the Chrome DevTools Protocol (the packaged
// app's fuses disable Node inspection, so Playwright's Electron launcher cannot attach), and checks:
// core readiness from the utility process, renderer isolation, navigation/window denial, crash recovery,
// that native code loads from the copied bundle (not the development tree), the fuses, memory, and
// graceful quit. Results and a screenshot go to CITSPARK_ARTIFACT_DIR (default: OS temp directory).
import { chromium } from "@playwright/test";
import { execFileSync, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const desktop = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = join(desktop, "..", "..");
const release = join(desktop, "build", "release");
const artifacts = process.env.CITSPARK_ARTIFACT_DIR ?? join(tmpdir(), "citspark-desktop-artifacts");
mkdirSync(artifacts, { recursive: true });

function fail(message) {
  console.error(`PACKAGED SMOKE FAILED: ${message}`);
  process.exitCode = 1;
  throw new Error(message);
}

function findPackaged() {
  if (!existsSync(release)) fail(`no packaged output in ${release}; run the dist script first`);
  const dirs = readdirSync(release);
  if (process.platform === "darwin") {
    const d = dirs.find((x) => x === `mac-${process.arch}` || x === "mac");
    if (!d) fail(`no mac app directory in ${release}`);
    return {
      dir: join(release, d),
      bundle: "Citspark.app",
      exe: "Citspark.app/Contents/MacOS/Citspark",
    };
  }
  if (process.platform === "win32") {
    if (!dirs.includes("win-unpacked")) fail("no win-unpacked directory");
    return { dir: join(release, "win-unpacked"), bundle: ".", exe: "Citspark.exe" };
  }
  if (!dirs.includes("linux-unpacked")) fail("no linux-unpacked directory");
  return { dir: join(release, "linux-unpacked"), bundle: ".", exe: "citspark" };
}

const until = async (what, pred, ms = 30_000) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() > end) fail(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
};

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function processTree(rootPid) {
  let rows;
  if (process.platform === "win32") {
    const json = execFileSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize | ConvertTo-Json -Compress",
      ],
      { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
    rows = JSON.parse(json).map((p) => ({
      pid: p.ProcessId,
      ppid: p.ParentProcessId,
      rssKB: Math.round(p.WorkingSetSize / 1024),
    }));
  } else {
    rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.trim().split(/\s+/).map(Number))
      .map(([pid, ppid, rssKB]) => ({ pid, ppid, rssKB }));
  }
  const tree = new Set([rootPid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) {
      if (tree.has(r.ppid) && !tree.has(r.pid)) {
        tree.add(r.pid);
        grew = true;
      }
    }
  }
  return rows.filter((r) => tree.has(r.pid));
}

function loadedNativeFiles(pid) {
  if (process.platform === "linux") {
    return [
      ...new Set(
        readFileSync(`/proc/${pid}/maps`, "utf8")
          .split("\n")
          .map((l) => l.split(/\s+/).slice(5).join(" "))
          .filter((p) => p.endsWith(".node")),
      ),
    ];
  }
  if (process.platform === "darwin") {
    return [
      ...new Set(
        execFileSync("lsof", ["-p", String(pid), "-Fn"], { encoding: "utf8" })
          .split("\n")
          .filter((l) => l.startsWith("n") && l.endsWith(".node"))
          .map((l) => l.slice(1)),
      ),
    ];
  }
  return undefined; // Windows: no lsof equivalent without extra tooling; recorded as not checked.
}

function readFuses(exePath) {
  const req = createRequire(
    createRequire(join(desktop, "package.json")).resolve("electron-builder/package.json"),
  );
  const fusesPath = createRequire(req.resolve("app-builder-lib/package.json")).resolve(
    "@electron/fuses",
  );
  return import(`file://${fusesPath.replaceAll("\\", "/")}`).then(async (fuses) => {
    const wire = await fuses.getCurrentFuseWire(exePath);
    const out = {};
    for (const [k, v] of Object.entries(fuses.FuseV1Options)) {
      if (typeof v === "number" && wire[v] !== undefined)
        out[k] = String.fromCharCode(wire[v]) === "1" ? "enabled" : "disabled";
    }
    return out;
  });
}

const packaged = findPackaged();
const work = mkdtempSync(join(tmpdir(), "citspark-packaged-"));
const appCopy = join(work, "app");
const userData = join(work, "userData");
mkdirSync(userData);
// Copy the packaged app out of the repository so nothing can resolve into the development tree.
if (process.platform === "darwin")
  execFileSync("ditto", [join(packaged.dir, packaged.bundle), join(appCopy, packaged.bundle)]);
else cpSync(packaged.dir, appCopy, { recursive: true, verbatimSymlinks: true });
const exe = join(appCopy, packaged.exe);

const report = {
  platform: process.platform,
  arch: process.arch,
  packagedFrom: packaged.dir,
  launchedCopy: exe,
  checks: {},
};
const env = {
  PATH: process.env.PATH,
  HOME: process.env.HOME ?? work,
  TMPDIR: process.env.TMPDIR ?? tmpdir(),
  ...(process.platform === "win32"
    ? {
        USERPROFILE: process.env.USERPROFILE,
        SystemRoot: process.env.SystemRoot,
        LOCALAPPDATA: process.env.LOCALAPPDATA,
        APPDATA: process.env.APPDATA,
        TEMP: process.env.TEMP,
        TMP: process.env.TMP,
      }
    : {}),
  ...(process.platform === "linux"
    ? { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY }
    : {}),
};
for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];

report.fuses = await readFuses(exe);
for (const [k, want] of Object.entries({
  RunAsNode: "disabled",
  EnableNodeOptionsEnvironmentVariable: "disabled",
  EnableNodeCliInspectArguments: "disabled",
  OnlyLoadAppFromAsar: "enabled",
})) {
  if (report.fuses[k] !== want) fail(`fuse ${k} is ${report.fuses[k]}, expected ${want}`);
}

const child = spawn(exe, [`--user-data-dir=${userData}`, "--remote-debugging-port=0"], {
  cwd: work,
  env,
  stdio: "ignore",
});
let browser;
try {
  const portFile = join(userData, "DevToolsActivePort");
  const port = await until(
    "DevToolsActivePort",
    () => existsSync(portFile) && readFileSync(portFile, "utf8").split("\n")[0],
  );
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const page = await until("app window", () =>
    browser
      .contexts()
      .flatMap((c) => c.pages())
      .find((p) => p.url().startsWith("citspark://app/")),
  );
  const status = page.getByRole("status", { name: "Core status" });
  await until("core ready", async () => (await status.getAttribute("data-core-state")) === "ready");
  await page.getByRole("button", { name: "Check core status" }).click();
  const pid = Number(await page.getByTestId("core-pid").textContent());
  if (!Number.isInteger(pid) || !alive(pid)) fail(`core pid ${pid} not running`);
  report.checks.coreReady = {
    pid,
    details: await page.getByRole("region", { name: "Core details" }).innerText(),
  };
  if (!existsSync(join(userData, "library", "library.sqlite")))
    fail("library was not created in the isolated userData");

  const tree = processTree(child.pid);
  if (!tree.some((p) => p.pid === pid)) fail("core process is not a child of the packaged app");
  report.memory = {
    note: "Resident memory (RSS / Windows working set) of the packaged app's process tree on this host, idle after core ready. Not the 8 GB reference machine.",
    totalMB: Math.round(tree.reduce((a, p) => a + p.rssKB, 0) / 1024),
    processes: tree.length,
  };

  const native = loadedNativeFiles(pid);
  if (native) {
    if (!native.some((f) => f.includes("better-sqlite3") || f.includes("prebuilds")))
      fail(`SQLite addon not loaded in core: ${native.join(", ")}`);
    if (native.some((f) => !f.startsWith(appCopy) && !f.startsWith(join("/private", appCopy))))
      fail(`native code loaded from outside the copied app: ${native.join(", ")}`);
    const mainFiles =
      process.platform === "darwin"
        ? execFileSync("lsof", ["-p", String(child.pid), "-Fn"], { encoding: "utf8" })
        : readFileSync(`/proc/${child.pid}/maps`, "utf8");
    if (mainFiles.includes(repoRoot)) fail("packaged app has files open in the development tree");
    report.checks.nativeFromBundle = native;
  } else {
    report.checks.nativeFromBundle = "not checked on this platform";
  }

  report.checks.renderer = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    api: Object.keys(window.citspark).sort(),
    windowOpen: window.open("https://example.com/") === null,
  }));
  if (
    report.checks.renderer.require !== "undefined" ||
    report.checks.renderer.process !== "undefined" ||
    !report.checks.renderer.windowOpen
  ) {
    fail(`renderer isolation: ${JSON.stringify(report.checks.renderer)}`);
  }
  // Invalid IPC from the renderer: main must reject it with a typed error, never crash or forward it.
  report.checks.invalidIpc = await page.evaluate(async () => {
    const run = async (...args) => {
      try {
        return await window.citspark.request(...args);
      } catch (e) {
        return { thrown: String(e) };
      }
    };
    return {
      wrongTypes: await run(42, "x"),
      oversized: await run("core.status", "x".repeat(70 * 1024)),
      unknown: await run("library.deleteEverything", {}, true),
      proto: await run("__proto__", null),
      ok: await run("core.status", null),
    };
  });
  const ipc = report.checks.invalidIpc;
  for (const [k, code] of Object.entries({
    wrongTypes: "invalid_message",
    oversized: "frame_too_large",
    unknown: "not_found",
    proto: "not_found",
  })) {
    if (ipc[k]?.ok !== false || ipc[k]?.error?.code !== code)
      fail(`invalid IPC ${k}: ${JSON.stringify(ipc[k])}`);
  }
  if (ipc.ok?.ok !== true || ipc.ok?.result?.state !== "ready")
    fail(`valid IPC after invalid ones: ${JSON.stringify(ipc.ok)}`);

  // Crash lifecycle: kill the real utility process; the supervisor must start a new one.
  process.kill(pid, "SIGKILL");
  await until("core restart", async () => {
    if ((await status.getAttribute("data-core-state")) !== "ready") return false;
    await page.getByRole("button", { name: "Check core status" }).click();
    const now = Number(await page.getByTestId("core-pid").textContent());
    return now !== pid && alive(now) ? now : false;
  });
  report.checks.crashRecovery = { killed: pid, alive: alive(pid) };
  if (alive(pid)) fail("killed core process still alive");

  await page.getByRole("button", { name: "Check core status" }).click();
  const finalPid = Number(await page.getByTestId("core-pid").textContent());
  report.checks.crashRecovery.restartedPid = finalPid;

  // Main-frame navigation denial. Done last: a cancelled navigation leaves Playwright's CDP frame waiting
  // for it, so later locator actions would stall. The marker proves the same document survived.
  const before = page.url();
  await page.evaluate(() => {
    window.__citsparkSmokeMarker = 1;
    location.href = "https://example.com/";
  });
  await new Promise((r) => setTimeout(r, 1500));
  const after = await page.evaluate(() => ({
    href: location.href,
    marker: window.__citsparkSmokeMarker,
  }));
  if (after.href !== before || after.marker !== 1 || page.url() !== before)
    fail(`navigation was not blocked: ${JSON.stringify(after)}`);
  report.checks.navigationBlocked = true;
  await page.screenshot({
    path: join(artifacts, `packaged-${process.platform}-${process.arch}.png`),
  });
  const exited = new Promise((r) => child.once("exit", r));
  // Close the only window the way a user would; the app then quits and stops the core first.
  const closed = page.waitForEvent("close", { timeout: 10_000 }).catch(() => undefined);
  void page.evaluate(() => window.close()).catch(() => undefined);
  await closed;
  await browser.close().catch(() => undefined);
  browser = undefined;
  await Promise.race([
    exited,
    new Promise((_, rej) => setTimeout(() => rej(new Error("app did not exit")), 15_000)),
  ]);
  await until("core reaped", () => !alive(finalPid), 5000);
  report.checks.quitReapsCore = true;
  report.result = "passed";
} finally {
  await browser?.close().catch(() => undefined);
  if (child.exitCode === null) child.kill("SIGKILL");
  writeFileSync(
    join(artifacts, `packaged-smoke-${process.platform}-${process.arch}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
console.log(JSON.stringify(report, null, 2));
console.log("Packaged smoke passed.");
