// T02 against mock X (M1-08): the built MV3 extension (`dist-test`) in a real Chromium with an
// isolated synthetic profile, the real native messaging host, the real core IPC server and store.
// No live X: every x.com request is answered by MockX through request interception, and every other
// host is blocked. Results, screenshots and logs go to $CITSPARK_T02_OUT (default: a temp dir).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { chromium, type BrowserContext, type Page, type Worker } from "playwright";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { PairingDialog } from "@citspark/core";
import { hostManifestDir, installNativeHost } from "@citspark/native-host";
import { EXTENSION_ID } from "../../src/identity.ts";
import {
  contentFreeReport,
  startDevDesktop,
  type DevDesktop,
} from "../../scripts/dev-desktop-lib.ts";
import { linearCollection, type PageSpec } from "../mock-x/bodies.ts";
import { CANARY, MockX, type Scenario } from "./mock-x-server.ts";
import { scanForCredentials } from "./scan.ts";

const root = join(import.meta.dirname, "..", "..");
const repo = join(root, "..", "..");
const OUT = process.env["CITSPARK_T02_OUT"] ?? mkdtempSync(join(tmpdir(), "cs-t02-out-"));
const CHANNEL = process.env["CITSPARK_T02_CHANNEL"] ?? "chromium";
mkdirSync(OUT, { recursive: true });
const LOG = join(OUT, "t02.log");
const log = (m: string) => appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`);

let work = "";
let userDataDir = "";
let context: BrowserContext;
let popup: Page;
let desktop: DevDesktop;
let sw: Worker;
const mock = new MockX();
const dialogs: PairingDialog[] = [];
const results: Record<string, unknown>[] = [];
const dbFiles: string[] = [];
let scenarioN = 0;

const TERMINAL = [
  "complete",
  "partial",
  "paused",
  "cancelled",
  "auth_required",
  "rate_limited",
  "failed",
  "desktop_unavailable",
];

async function popupState(): Promise<{ state: string; text: string; link: string }> {
  return popup.evaluate(() => ({
    state: document.getElementById("run")!.dataset["state"] ?? "",
    text: document.getElementById("run")!.textContent ?? "",
    link: document.getElementById("link")!.dataset["state"] ?? "",
  }));
}

async function waitFor<T>(
  f: () => Promise<T | undefined | false>,
  ms: number,
  what: string,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await f();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * Samples the popup state every 50 ms until `stop()`, one sample at a time. The loop is a single
 * awaited promise, never a timer firing detached `page.evaluate` calls: a detached sample that loses
 * the race with a popup reload rejects with nobody listening (an unhandled error), and a timer that
 * a failing test never clears keeps sampling a closed browser. Call `stop()` in a `finally`.
 * A sample lost to a popup navigation is recorded as "navigation"; any other error is kept verbatim.
 */
function sampleStates(): { stop: () => Promise<{ seen: string[]; errors: string[] }> } {
  const seen: string[] = [];
  const errors: string[] = [];
  let running = true;
  const loop = (async () => {
    while (running) {
      try {
        seen.push((await popupState()).state);
      } catch (e) {
        errors.push(
          String(e).includes("Execution context was destroyed") ? "navigation" : String(e),
        );
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  })();
  return {
    async stop() {
      running = false;
      await loop;
      return { seen, errors };
    },
  };
}

/**
 * Clicks a popup button 50 ms from now (from a MockX page hook, which must stay synchronous). The
 * click's outcome is captured at once, so a failed click is reported by the test that awaits it
 * rather than surfacing as an unhandled rejection; resolves to null when the click succeeded.
 */
function clickSoon(selector: string): Promise<unknown> {
  return new Promise((r) => setTimeout(r, 50))
    .then(() => popup.click(selector))
    .then(
      () => null,
      (e: unknown) => e,
    );
}

async function refreshPopup(): Promise<void> {
  await popup.reload();
  await popup.waitForSelector("#link");
}

async function openX(path = "/home"): Promise<Page> {
  for (const p of context.pages()) if (p.url().startsWith("https://x.com/")) await p.close();
  const x = await context.newPage();
  await x.goto(`https://x.com${path}`);
  await x.waitForTimeout(300);
  return x;
}

interface Outcome {
  state: string;
  text: string;
  report: Record<string, unknown>[];
}

async function capture(
  name: string,
  scenario: Scenario,
  setup?: () => Promise<void>,
): Promise<Outcome> {
  scenarioN++;
  const dbPath = join(work, `library-${scenarioN}-${name}.sqlite`);
  dbFiles.push(dbPath, `${dbPath}-wal`, `${dbPath}-shm`);
  desktop.useDatabase(dbPath);
  mock.set(scenario);
  const x = await openX();
  await refreshPopup();
  await setup?.();
  await waitFor(async () => (await popupState()).link === "ready", 15_000, "desktop link ready");
  await popup.selectOption("#collection", "bookmarks");
  await popup.click("#start");
  const end = await waitFor(
    async () => {
      const s = await popupState();
      return TERMINAL.includes(s.state) ? s : undefined;
    },
    90_000,
    `${name} terminal state`,
  );
  await popup.screenshot({ path: join(OUT, `${scenarioN}-${name}-popup.png`) });
  await x.screenshot({ path: join(OUT, `${scenarioN}-${name}-mockx.png`) });
  const report = contentFreeReport(desktop.db()) as Record<string, unknown>[];
  const outcome = { state: end.state, text: end.text, report };
  results.push({ scenario: name, ...outcome, xRequests: mock.recorded.length });
  log(`${name}: ${end.state} | ${end.text} | ${JSON.stringify(report)}`);
  await x.close();
  return outcome;
}

/** Every X API request in a scenario was sent by the mock page's own code with its own headers. */
function assertPassive(): void {
  for (const r of mock.recorded) {
    expect(r.issuedByPage, `${r.op} issued by the page`).toBe(true);
    expect(r.authorization).toBe(`Bearer ${CANARY.bearer}`);
    expect(r.csrf).toBe(CANARY.csrf);
  }
}

beforeAll(async () => {
  work = mkdtempSync(join(tmpdir(), "cs-t02-"));
  userDataDir = join(work, "profile");
  const ipcDir = join(work, "ipc");
  mkdirSync(ipcDir, { mode: 0o700 });
  const socketPath = join(ipcDir, "core.sock");
  desktop = await startDevDesktop({
    socketPath,
    dbPath: join(work, "library-0.sqlite"),
    present: (_prompt, dialog) => {
      dialogs.push(dialog);
      return () => undefined;
    },
  });
  // The browser starts the host itself. On macOS a host process spawned by Chrome for Testing
  // inherits the browser's privacy (TCC) context, and opening files under a protected folder such as
  // ~/Desktop or ~/Documents (where a checkout may live) blocks forever without a visible prompt. So
  // the harness runs the same host source bundled into its own work dir, like an installed host.
  const hostCli = join(work, "host", "cli.mjs");
  await build({
    entryPoints: [join(repo, "packages", "native-host", "src", "cli.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: hostCli,
    logLevel: "warning",
  });
  const host = await installNativeHost({
    extensionIds: [EXTENSION_ID],
    socketPath,
    nodePath: process.execPath,
    cliPath: hostCli,
    installDir: join(work, "host"),
    manifestDir: hostManifestDir({
      browser: "chromium",
      platform: process.platform,
      home: "/nonexistent",
      userDataDir,
    }),
  });
  log(`node=${process.execPath} ${process.version} abi=${process.versions.modules}`);
  log(`native host launcher=${host.launcherPath} manifest=${host.manifestPath}`);
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: CHANNEL,
    headless: process.env["CITSPARK_T02_HEADED"] !== "1",
    args: [
      `--disable-extensions-except=${join(root, "dist-test")}`,
      `--load-extension=${join(root, "dist-test")}`,
      // Belt and braces: nothing may resolve; MockX answers x.com before DNS.
      "--host-resolver-rules=MAP * ~NOTFOUND",
      "--no-first-run",
    ],
  });
  await mock.install(context);
  sw = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
  log(`browser=${context.browser()?.version() ?? "persistent"} sw=${sw.url()}`);
  expect(sw.url()).toBe(`chrome-extension://${EXTENSION_ID}/background.js`);
  popup = await context.newPage();
  await popup.goto(`chrome-extension://${EXTENSION_ID}/popup.html`);
  // The popup script must load and reach the worker: a dead worker or blocked popup.js leaves it on
  // the initial render forever, which every later test would only see as a timeout.
  await waitFor(
    async () => (await popupState()).link !== "checking" || undefined,
    15_000,
    "popup connected to the service worker",
  );
  expect([...mock.foreignHosts]).not.toContain(EXTENSION_ID);
}, 120_000);

afterAll(async () => {
  writeFileSync(join(OUT, "t02-results.json"), JSON.stringify(results, null, 2));
  await context?.close();
  await desktop?.close();
  if (work && process.env["CITSPARK_T02_KEEP"] !== "1")
    rmSync(work, { recursive: true, force: true });
});

const C6: PageSpec[] = linearCollection(6, 5);

describe("T02 against mock X: built extension, real host, real store", () => {
  test("before pairing the popup says the extension is not paired", async () => {
    await refreshPopup();
    const s = await waitFor(
      async () => {
        const v = await popupState();
        return v.link !== "checking" ? v : undefined;
      },
      15_000,
      "link state",
    );
    expect(s.link).toBe("not_paired");
    await popup.screenshot({ path: join(OUT, "0-not-paired.png") });
  });

  test("mutual two-code pairing through the real host (ADR 0011)", async () => {
    await popup.click("#pair");
    const code = await waitFor(
      async () => (await popup.textContent("#client-code"))?.trim() || undefined,
      15_000,
      "client code",
    );
    const dialog = await waitFor(async () => dialogs.at(-1), 5_000, "desktop dialog");
    expect(dialog.submit(code)).toBe("ok");
    await popup.fill("#desktop-code", dialog.desktopCode()!);
    await popup.click("#confirm-code");
    await waitFor(async () => (await popupState()).link === "ready", 15_000, "paired");
    expect(desktop.registry.list()).toHaveLength(1);
    await popup.screenshot({ path: join(OUT, "0-paired.png") });
    await popup.fill("#budget-limit", "1000");
    await popup.click("#save-budget");
  });

  test("full pass completes; commits are atomic and passive", async () => {
    const o = await capture("full", { pages: C6 });
    expect(o.state).toBe("complete");
    expect(o.report[0]).toMatchObject({ state: "complete", pages: 6, distinctSources: 30 });
    assertPassive();
  });

  test("resume after pause scrolls a fresh pass from the top, catches up, then completes", async () => {
    let pauseClick: Promise<unknown> | undefined;
    const first = await capture("resume-1", {
      pages: C6,
      onPage: (i) => {
        if (i === 2 && !pauseClick) pauseClick = clickSoon("#pause");
      },
    });
    expect(await pauseClick).toBeNull();
    expect(first.state).toBe("paused");
    const committed = first.report[0]!["pages"] as number;
    expect(committed).toBeGreaterThan(0);
    expect(committed).toBeLessThan(6);
    // Samples race the popup reload below; a sample lost to that navigation is expected, any other
    // sampling error fails the test (nothing is dropped silently).
    const sampler = sampleStates();
    let sampled: { seen: string[]; errors: string[] };
    let end: { state: string; text: string };
    const x = await openX();
    try {
      // Same library: resume the same job.
      const dbPath = dbFiles.at(-3)!;
      desktop.useDatabase(dbPath);
      mock.set({ pages: C6 });
      await refreshPopup();
      await waitFor(async () => (await popupState()).link === "ready", 15_000, "ready");
      await popup.click("#start");
      end = await waitFor(
        async () => {
          const s = await popupState();
          return TERMINAL.includes(s.state) ? s : undefined;
        },
        90_000,
        "resume end",
      );
    } finally {
      sampled = await sampler.stop();
    }
    const seen = sampled.seen;
    await popup.screenshot({ path: join(OUT, "resume-2-popup.png") });
    await x.close();
    const report = contentFreeReport(desktop.db()) as Record<string, unknown>[];
    log(
      `resume-2: ${end.state} | ${end.text} | ${JSON.stringify(report)} | seen=${[...new Set(seen)].join(",")}`,
    );
    results.push({ scenario: "resume-2", state: end.state, report, seen: [...new Set(seen)] });
    expect(sampled.errors.filter((e) => e !== "navigation")).toEqual([]);
    expect(end.state).toBe("complete");
    expect(seen).toContain("catching_up");
    expect(report[0]).toMatchObject({
      state: "complete",
      passes: 2,
      distinctSources: 30,
      pages: committed + 6,
    });
    assertPassive();
  });

  test("cursor loop never completes", async () => {
    const o = await capture("cursor-loop", { pages: C6, loopAt: 3 });
    expect(o.state).toBe("failed");
    expect(o.text).toMatch(/repeated a page/);
    expect(o.report[0]).toMatchObject({ state: "failed" });
  });

  test("auth failure stops as auth_required", async () => {
    const o = await capture("auth", { pages: C6, faults: { 1: [{ status: 401 }] } });
    expect(o.state).toBe("auth_required");
    expect(o.report[0]).toMatchObject({ state: "auth_required" });
  });

  test("429 with Retry-After waits at least that long, then continues to the end", async () => {
    const o = await capture("429-retry", {
      pages: C6,
      faults: { 2: [{ status: 429, retryAfter: "2" }] },
    });
    expect(o.state).toBe("complete");
    const two = mock.recorded.filter(
      (r) => r.op === "Bookmarks" && r.cursor?.endsWith("_CURSOR_2"),
    );
    expect(two.map((r) => r.status)).toEqual([429, 200]);
    expect(two[1]!.at - two[0]!.at).toBeGreaterThanOrEqual(2000);
    assertPassive();
  });

  test("persistent 429 stops as rate_limited", async () => {
    const many = Array.from({ length: 8 }, () => ({ status: 429, retryAfter: "1" }));
    const o = await capture("429-stop", { pages: C6, faults: { 1: many } });
    expect(o.state).toBe("rate_limited");
    expect(o.report[0]).toMatchObject({ state: "rate_limited" });
  });

  test("unsupported schema pauses honestly (CAP-07)", async () => {
    const pages = C6.map((p, i) => (i === 2 ? { ...p, unsupported: true } : p));
    const o = await capture("schema", { pages });
    expect(o.state).toBe("paused");
    expect(o.text).toMatch(/changed its page format/);
  });

  test("disk full pauses and never completes", async () => {
    const pages = C6.map((p) => ({ ...p, textRepeat: 400 }));
    const o = await capture("disk-full", {
      pages,
      onPage: (i) => {
        if (i === 2) {
          const db = desktop.db();
          db.pragma("wal_checkpoint(TRUNCATE)");
          db.pragma(`max_page_count = ${db.pragma("page_count", { simple: true }) as number}`);
        }
      },
    });
    desktop.db().pragma("max_page_count = 1073741823");
    expect(o.state).toBe("paused");
    expect(o.text).toMatch(/disk is full/);
    expect(o.report[0]).toMatchObject({ state: "paused" });
  });

  test("a partial thread ends partial, not complete", async () => {
    const pages = C6.map((p, i) => (i === 3 ? { ...p, partialThread: true } : p));
    const o = await capture("partial-thread", { pages });
    expect(o.state).toBe("partial");
    expect(o.report[0]).toMatchObject({ state: "partial" });
  });

  test("an unavailable post ends partial, not complete", async () => {
    const pages = C6.map((p, i) => (i === 1 ? { ...p, tombstone: true } : p));
    const o = await capture("tombstone", { pages });
    expect(o.state).toBe("partial");
  });

  test("an account switch in the tab pauses before merging (CAP-02)", async () => {
    const o = await capture("account-switch", { pages: C6, switchAccountAfter: 3 });
    expect(o.state).toBe("paused");
    expect(o.text).toMatch(/different X account/);
  });

  test("cancel keeps committed pages", async () => {
    let cancelClick: Promise<unknown> | undefined;
    const o = await capture("cancel", {
      pages: C6,
      onPage: (i) => {
        if (i === 2 && !cancelClick) cancelClick = clickSoon("#cancel");
      },
    });
    expect(await cancelClick).toBeNull();
    expect(o.state).toBe("cancelled");
    expect(o.report[0]!["pages"]).toBeGreaterThan(0);
  });

  test("the daily page budget pauses the pass", async () => {
    const o = await capture("budget", { pages: C6 }, async () => {
      await popup.fill("#budget-limit", "1");
      await popup.click("#save-budget");
      await popup.waitForTimeout(200);
    });
    await popup.fill("#budget-limit", "1000");
    await popup.click("#save-budget");
    expect(o.state).toBe("paused");
    expect(o.text).toMatch(/daily page budget/);
  });

  test("desktop not running shows a clear state", async () => {
    await desktop.server.close();
    await refreshPopup();
    // A "Connected" rendered in the instant before the dropped session is noticed is allowed; it
    // must turn into desktop_unavailable on its own (the worker re-checks when the session closes).
    const s = await waitFor(
      async () => {
        const v = await popupState();
        return v.link !== "checking" && v.link !== "ready" ? v : undefined;
      },
      15_000,
      "unavailable",
    );
    await popup.screenshot({ path: join(OUT, "desktop-unavailable.png") });
    expect(s.link).toBe("desktop_unavailable");
    results.push({ scenario: "desktop-unavailable", link: s.link });
  });

  test("credential scanner: no cookie, bearer or CSRF value in any stored output (SEC-04)", async () => {
    // The synthetic session really existed in the browser (the canaries were live, not inert).
    const live = await context.cookies("https://x.com");
    expect(live.find((c) => c.name === "auth_token")?.value).toBe(CANARY.authToken);
    await context.close();
    const ext = join(userDataDir, "Default");
    const scanned = [
      ...dbFiles,
      join(ext, "IndexedDB"),
      join(ext, "Local Extension Settings"),
      join(ext, "Extension State"),
      join(ext, "Local Storage"),
      join(ext, "Session Storage"),
      LOG,
      join(OUT, "t02-results.json"),
    ];
    writeFileSync(join(OUT, "t02-results.json"), JSON.stringify(results, null, 2));
    const findings = scanForCredentials(scanned, Object.values(CANARY));
    // Positive control: the scanner finds every canary in a planted file, in both encodings it reads.
    // (Chrome encrypts cookie values at rest, so its Cookies DB is not a usable control on macOS.)
    const controlDir = join(work, "scanner-control");
    mkdirSync(controlDir, { recursive: true });
    const planted = Object.values(CANARY).join("\n");
    writeFileSync(join(controlDir, "latin1.bin"), Buffer.from(planted, "latin1"));
    writeFileSync(join(controlDir, "utf16.bin"), Buffer.from(planted, "utf16le"));
    const control = scanForCredentials([controlDir], Object.values(CANARY));
    const wanted = Object.values(CANARY).filter((c) => c.length >= 8).length * 2;
    log(`scanner findings=${JSON.stringify(findings)} control=${control.length}/${wanted}`);
    results.push({ scenario: "credential-scan", findings, positiveControl: control.length });
    expect(control.filter((f) => f.match.startsWith("canary:"))).toHaveLength(wanted);
    expect(findings).toEqual([]);
    expect([...mock.foreignHosts].filter((h) => h !== "")).toEqual([]);
  });
});
