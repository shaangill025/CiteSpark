import {
  _electron as electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { APP_DIR, ARTIFACT_DIR, alive, PRELOAD } from "./paths.ts";

// Real Electron, real utility process, real core: these drive the staged app that electron-builder packages.
// Every run uses a fresh synthetic userData directory; the user's real profile is never touched.

let userData: string;
let app: ElectronApplication | undefined;
let proxy: { server: Server; connections: number } | undefined;

test.beforeEach(async () => {
  userData = mkdtempSync(join(tmpdir(), "citspark-e2e-"));
  proxy = await recordingProxy();
});

test.afterEach(async () => {
  await app?.close().catch(() => undefined);
  app = undefined;
  proxy?.server.close();
  rmSync(userData, { recursive: true, force: true });
});

async function recordingProxy(): Promise<{ server: Server; connections: number }> {
  const rec = { server: createServer(), connections: 0 };
  rec.server.on("connection", (s) => {
    rec.connections++;
    s.destroy();
  });
  await new Promise<void>((r) => rec.server.listen(0, "127.0.0.1", r));
  return rec;
}

async function launch(): Promise<{ app: ElectronApplication; page: Page }> {
  const port = (proxy!.server.address() as { port: number }).port;
  app = await electron.launch({
    args: [
      APP_DIR,
      `--user-data-dir=${userData}`,
      // Any request Chromium makes, including loopback, goes to a proxy that only counts connections.
      `--proxy-server=http://127.0.0.1:${port}`,
      "--proxy-bypass-list=<-loopback>",
    ],
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "0" },
  });
  const page = await app.firstWindow();
  return { app, page };
}

const coreState = (page: Page) => page.getByRole("status", { name: "Core status" });

async function ready(page: Page) {
  await expect(coreState(page)).toHaveAttribute("data-core-state", "ready", { timeout: 20_000 });
}

test("hosts the core in an Electron utility process and shows honest readiness", async () => {
  const { app, page } = await launch();
  await ready(page);
  await expect(page.getByRole("heading", { level: 1, name: "Citspark" })).toBeVisible();
  await expect(page.getByText(/preview.*not usable yet/i)).toBeVisible();

  // The status comes from the running core over the protocol, not from the shell.
  await page.getByRole("button", { name: "Check core status" }).click();
  const details = page.getByRole("region", { name: "Core details" });
  await expect(details).toContainText("Library schema version7");
  const pid = Number(await details.getByTestId("core-pid").textContent());

  const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
  const utility = metrics.find((m) => m.pid === pid);
  expect(utility?.type).toBe("Utility");
  expect(existsSync(join(userData, "library", "library.sqlite"))).toBe(true);

  mkdirSync(ARTIFACT_DIR, { recursive: true });
  await page.screenshot({ path: join(ARTIFACT_DIR, "shell-ready.png") });
  const byType: Record<string, number> = {};
  for (const m of metrics) byType[m.type] = (byType[m.type] ?? 0) + m.memory.workingSetSize;
  writeFileSync(
    join(ARTIFACT_DIR, "unpackaged-memory.json"),
    JSON.stringify(
      {
        note: "Electron app.getAppMetrics() workingSetSize in KB on this host at idle after core ready. Not the 8 GB reference machine.",
        platform: process.platform,
        arch: process.arch,
        totalKB: Object.values(byType).reduce((a, b) => a + b, 0),
        byType,
      },
      null,
      2,
    ),
  );
  expect(proxy!.connections).toBe(0);
});

test("renderer has no Node, Electron or privileged APIs", async () => {
  const { page } = await launch();
  await ready(page);
  const probe = await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    return {
      require: typeof w.require,
      process: typeof w.process,
      module: typeof w.module,
      Buffer: typeof w.Buffer,
      electron: typeof w.electron,
      ipcRenderer: typeof w.ipcRenderer,
      api: Object.keys(w.citspark as object).sort(),
      frozen: Object.isFrozen(w.citspark),
      origin: location.origin,
    };
  });
  expect(probe).toEqual({
    require: "undefined",
    process: "undefined",
    module: "undefined",
    Buffer: "undefined",
    electron: "undefined",
    ipcRenderer: "undefined",
    api: ["onStatus", "request", "restartCore", "status"],
    frozen: true,
    origin: "citspark://app",
  });

  // CSP, exercised by the page itself (DevTools evaluation is exempt from CSP, so the probes are planted
  // into the document): inline script, inline handlers, string eval and remote script must all be refused.
  const csp = await page.evaluate(async () => {
    const w = window as unknown as Record<string, unknown>;
    const violations: string[] = [];
    document.addEventListener("securitypolicyviolation", (e) =>
      violations.push(e.violatedDirective),
    );
    const inline = document.createElement("script");
    inline.textContent = "window.__inlineRan = true";
    document.body.append(inline);
    const img = document.createElement("div");
    img.innerHTML = '<img src="citspark://app/missing.png" onerror="window.__handlerRan = true">';
    document.body.append(img);
    const remote = document.createElement("script");
    remote.src = "https://example.com/x.js";
    document.body.append(remote);
    // setTimeout with a string is eval; the CSP must refuse it.
    (setTimeout as unknown as (code: string, ms: number) => void)("window.__evalRan = true", 0);
    await new Promise((r) => setTimeout(r, 300));
    return {
      inlineRan: w.__inlineRan === true,
      handlerRan: w.__handlerRan === true,
      evalRan: w.__evalRan === true,
      violations: [...new Set(violations)].sort(),
    };
  });
  expect(csp.inlineRan).toBe(false);
  expect(csp.handlerRan).toBe(false);
  expect(csp.evalRan).toBe(false);
  expect(csp.violations.length).toBeGreaterThan(0);

  // Network and file access fail from the renderer.
  const fetched = await page.evaluate(async () => {
    const out: string[] = [];
    for (const url of ["https://example.com/", "http://127.0.0.1:1/", "file:///etc/hosts"]) {
      try {
        await fetch(url);
        out.push(`${url} allowed`);
      } catch {
        out.push(`${url} blocked`);
      }
    }
    return out;
  });
  expect(fetched.every((r) => r.endsWith("blocked"))).toBe(true);
  expect(proxy!.connections).toBe(0);
});

test("main process rejects malformed, oversized and unknown requests", async () => {
  const { page } = await launch();
  await ready(page);
  const results = await page.evaluate(async () => {
    const api = (
      window as unknown as { citspark: { request: (...a: unknown[]) => Promise<unknown> } }
    ).citspark;
    const run = async (...args: unknown[]) => {
      try {
        return await api.request(...args);
      } catch (e) {
        return { thrown: String(e) };
      }
    };
    return {
      wrongTypes: await run(42, "x"),
      oversized: await run("core.status", "x".repeat(70 * 1024)),
      unknown: await run("library.deleteEverything", {}, true),
      proto: await run("__proto__", null),
      fn: await run("core.status", { f: "x", nested: [1, 2, { a: null }] }),
      ok: await run("core.status", null),
    };
  });
  expect(results.wrongTypes).toMatchObject({ ok: false, error: { code: "invalid_message" } });
  expect(results.oversized).toMatchObject({ ok: false, error: { code: "frame_too_large" } });
  expect(results.unknown).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(results.proto).toMatchObject({ ok: false, error: { code: "not_found" } });
  expect(results.ok).toMatchObject({ ok: true, result: { state: "ready" } });
});

test("blocks navigation, new windows and permission requests", async () => {
  const { app, page } = await launch();
  await ready(page);
  const before = page.url();
  await page.evaluate(() => {
    location.href = "https://example.com/";
  });
  await page.waitForTimeout(500);
  expect(page.url()).toBe(before);
  const opened = await page.evaluate(() => window.open("https://example.com/") === null);
  expect(opened).toBe(true);
  await page.waitForTimeout(300);
  expect(app.windows()).toHaveLength(1);
  const perms = await page.evaluate(async () => {
    const notification = await Notification.requestPermission();
    let media = "granted";
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      media = "denied";
    }
    return { notification, media };
  });
  expect(perms).toEqual({ notification: "denied", media: "denied" });
  expect(proxy!.connections).toBe(0);
});

test("refuses IPC from a document that is not the app", async () => {
  const { app, page } = await launch();
  await ready(page);
  const outcome = await app.evaluate(async ({ BrowserWindow, session }, preload) => {
    // Simulates a foreign document that somehow got the preload: lift the app's request filter for a
    // throwaway partition only, so a data: document can load there.
    session.fromPartition("probe").webRequest.onBeforeRequest(null);
    const w = new BrowserWindow({
      show: false,
      webPreferences: { preload, sandbox: true, contextIsolation: true, partition: "probe" },
    });
    await w.loadURL("data:text/html,<p>untrusted</p>");
    const result = await w.webContents.executeJavaScript(
      "window.citspark.status().then(() => 'answered', (e) => 'refused: ' + e.message)",
    );
    w.destroy();
    return result as string;
  }, PRELOAD);
  expect(outcome).toMatch(/^refused/);
});

test("restarts the core after its process is killed", async () => {
  const { app, page } = await launch();
  await ready(page);
  await page.getByRole("button", { name: "Check core status" }).click();
  const pid = Number(await page.getByTestId("core-pid").textContent());
  process.kill(pid, "SIGKILL");
  await expect(coreState(page)).not.toHaveAttribute("data-core-state", "ready", {
    timeout: 10_000,
  });
  await ready(page);
  await page.getByRole("button", { name: "Check core status" }).click();
  await expect(page.getByTestId("core-pid")).not.toHaveText(String(pid));
  const metrics = await app.evaluate(({ app }) => app.getAppMetrics());
  expect(metrics.filter((m) => m.type === "Utility" && m.pid === pid)).toHaveLength(0);
  expect(alive(pid)).toBe(false);
});

test("reports an unreadable library honestly and recovers on retry", async () => {
  mkdirSync(join(userData, "library"), { recursive: true });
  const lib = join(userData, "library", "library.sqlite");
  writeFileSync(lib, "synthetic garbage, not a database ".repeat(200));
  const { page } = await launch();
  await expect(coreState(page)).toHaveAttribute("data-core-state", "failed", { timeout: 20_000 });
  await expect(page.getByRole("alert")).toContainText("could not be read");
  await expect(page.getByRole("button", { name: "Check core status" })).toHaveCount(0);
  rmSync(lib);
  await page.getByRole("button", { name: "Try again" }).click();
  await ready(page);
});

test("quitting stops and reaps the core process", async () => {
  const { app, page } = await launch();
  await ready(page);
  await page.getByRole("button", { name: "Check core status" }).click();
  const pid = Number(await page.getByTestId("core-pid").textContent());
  await app.close();
  expect(alive(pid)).toBe(false);
});
