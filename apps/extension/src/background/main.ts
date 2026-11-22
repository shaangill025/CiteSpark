// MV3 service worker: pairing, the desktop link, and capture runs (ADR 0005, ADR 0006, ADR 0011).
import { parseCollectionKey, xAdapter, type CollectionRef } from "@citspark/capture-x";
import { CaptureMethod, type CapturePageResult, type CaptureStartResult } from "@citspark/protocol";
import { NATIVE_HOST_NAME } from "../shared/constants.ts";
import type { FolderInfo, PopupCommand, UiState } from "../shared/messages.ts";
import { idbKv } from "./idb.ts";
import { PairingStore } from "./keystore.ts";
import { DesktopLink, LinkError, type PortLike } from "./link.ts";
import { DailyBudget, RELEASE_PACING, TEST_PACING } from "./pacer.ts";
import { CaptureRun, type Observation } from "./run.ts";

declare const __CITSPARK_FLAVOR__: string;
const FLAVOR = typeof __CITSPARK_FLAVOR__ === "string" ? __CITSPARK_FLAVOR__ : "release";
const pacing = FLAVOR === "test" ? TEST_PACING : RELEASE_PACING;
const VERSION = chrome.runtime.getManifest().version;

const kv = idbKv();
const store = new PairingStore(kv);
const budget = new DailyBudget(pacing, kv);
let nativeError: string | undefined;
const link = new DesktopLink({
  openPort: (): PortLike => {
    nativeError = undefined;
    const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    // Registered first, so the error is recorded before the transport sees the disconnect.
    port.onDisconnect.addListener(() => {
      nativeError = chrome.runtime.lastError?.message;
    });
    return port;
  },
  lastError: () => nativeError,
  store,
  version: VERSION,
  // Re-check (and publish) at once, so the popup never keeps "Connected" after the desktop went away.
  onSessionClosed: () =>
    void refresh().catch(() =>
      publish({ link: "desktop_unavailable", linkMessage: linkMessage("desktop_unavailable") }),
    ),
});

interface XTab {
  port: chrome.runtime.Port | undefined;
  account: { accountId: string; handle: string } | null;
  folders: FolderInfo[];
  waiters: ((a: { accountId: string; handle: string }) => void)[];
}
const tabs = new Map<number, XTab>();
let lastXTab: number | undefined;
const tab = (id: number): XTab => {
  let t = tabs.get(id);
  if (!t) tabs.set(id, (t = { port: undefined, account: null, folders: [], waiters: [] }));
  return t;
};

let ui: UiState = {
  link: "checking",
  pairing: null,
  account: null,
  xTab: false,
  folders: [],
  run: null,
  budget: { limit: pacing.defaultDailyPageBudget, used: 0 },
  flavor: FLAVOR,
};
const popups = new Set<chrome.runtime.Port>();
let run: CaptureRun | undefined;
let runTab: number | undefined;
let pairing: { abort: AbortController; code?: (c: string) => void } | undefined;

function publish(patch: Partial<UiState> = {}): void {
  ui = { ...ui, ...patch };
  for (const p of popups) p.postMessage(ui);
}

async function refresh(tabId?: number): Promise<void> {
  const id = tabId !== undefined && tabs.has(tabId) ? tabId : lastXTab;
  const t = id === undefined ? undefined : tabs.get(id);
  const now = Date.now();
  publish({
    xTab: t !== undefined,
    account: t?.account ?? null,
    folders: t?.folders ?? [],
    budget: { limit: await budget.limit(), used: await budget.used(now) },
  });
  if (pairing) return;
  const state = await link.check();
  publish({ link: state, linkMessage: linkMessage(state) });
}

function linkMessage(state: UiState["link"]): string {
  switch (state) {
    case "ready":
      return "Connected to Citspark.";
    case "not_paired":
      return "Not paired. Pair this extension with the Citspark desktop app.";
    case "host_missing":
      return "The Citspark helper is not installed for this browser. Install Citspark, then try again.";
    case "desktop_unavailable":
      return "Citspark is not running. Open the Citspark desktop app and try again.";
    case "incompatible":
      return "This extension and Citspark are different versions. Update the older one.";
    case "pairing_invalid":
      return "Citspark no longer accepts this extension. Pair it again.";
    default:
      return "Checking Citspark…";
  }
}

function onObservation(tabId: number, obs: Observation): void {
  lastXTab = tabId;
  const t = tab(tabId);
  if (obs.kind === "viewer" && obs.status === 200 && obs.body) {
    try {
      const a = xAdapter.detectAccount(JSON.parse(obs.body));
      if (a) {
        t.account = a;
        for (const w of t.waiters.splice(0)) w(a);
      }
    } catch {
      // not a viewer body we understand
    }
  } else if (obs.kind === "folders" && obs.status === 200 && obs.body) {
    try {
      t.folders = xAdapter
        .listCollections(JSON.parse(obs.body))
        .flatMap((c) =>
          c.kind === "bookmark_folder" ? [{ folderId: c.folderId, name: c.name }] : [],
        );
    } catch {
      t.folders = [];
    }
  }
  if (run && runTab === tabId) void run.observe(obs);
  if (popups.size > 0 && obs.kind !== "page") void refresh(tabId);
}

function collectionUrl(c: CollectionRef, handle: string): string {
  if (c.kind === "bookmarks") return "https://x.com/i/bookmarks";
  if (c.kind === "likes") return `https://x.com/${encodeURIComponent(handle)}/likes`;
  return `https://x.com/i/bookmarks/${c.folderId}`;
}

function waitForAccount(tabId: number, ms: number) {
  const t = tab(tabId);
  return new Promise<{ accountId: string; handle: string } | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    t.waiters.push((a) => {
      clearTimeout(timer);
      resolve(a);
    });
  });
}

async function start(tabId: number, key: string): Promise<void> {
  if (run && !run.terminal) return;
  const id = tabs.has(tabId) ? tabId : lastXTab;
  const collection = parseCollectionKey(key);
  if (id === undefined || !collection) {
    publish({
      run: { state: "failed", reason: "no_x_tab", collection: key, pages: 0, newRecords: 0 },
    });
    return;
  }
  let account = tab(id).account;
  if (!account) {
    // Learn the signed-in account from X's own viewer request on a normal page load (CAP-02).
    await chrome.tabs.update(id, { url: "https://x.com/i/bookmarks" });
    account = await waitForAccount(id, 20_000);
  }
  if (!account) {
    publish({
      run: {
        state: "auth_required",
        reason: "account_unknown",
        collection: key,
        pages: 0,
        newRecords: 0,
      },
    });
    return;
  }
  const bound = account;
  runTab = id;
  run = new CaptureRun({
    collection,
    accountId: bound.accountId,
    desktop: {
      start: async (p) =>
        (await link.request(CaptureMethod.start, p, crypto.randomUUID())) as CaptureStartResult,
      page: async (p, rid) => (await link.request(CaptureMethod.page, p, rid)) as CapturePageResult,
      stop: (p) => link.request(CaptureMethod.stop, p, crypto.randomUUID()),
    },
    tab: {
      scroll: () => tabs.get(id)?.port?.postMessage({ type: "scroll" }),
      load: () => void chrome.tabs.update(id, { url: collectionUrl(collection, bound.handle) }),
    },
    timers: { set: (fn, ms) => setTimeout(fn, ms), clear: (t) => clearTimeout(t as number) },
    now: Date.now,
    random: Math.random,
    pacing,
    budget,
    onUpdate: (s) => {
      publish({ run: s });
      void refresh(id);
    },
  });
  publish({ run: run.status });
  try {
    await run.begin();
  } catch (e) {
    publish({
      run: {
        ...run.status,
        state: "desktop_unavailable",
        reason: e instanceof LinkError ? e.state : "desktop_unavailable",
      },
    });
  }
}

async function pair(): Promise<void> {
  pairing?.abort.abort();
  const abort = new AbortController();
  const session: NonNullable<typeof pairing> = { abort };
  pairing = session;
  publish({ pairing: { awaitingDesktopCode: false }, link: "checking" });
  try {
    await link.pair({
      signal: abort.signal,
      showCode: (code) => publish({ pairing: { code, awaitingDesktopCode: true } }),
      enterDesktopCode: (signal) =>
        new Promise<string>((resolve, reject) => {
          session.code = resolve;
          signal.addEventListener("abort", () => reject(new Error("pairing ended")), {
            once: true,
          });
        }),
    });
    pairing = undefined;
    publish({ pairing: null });
  } catch (e) {
    pairing = undefined;
    publish({
      pairing: {
        awaitingDesktopCode: false,
        error: e instanceof Error ? e.message : "Pairing failed.",
      },
    });
  }
  await refresh();
}

chrome.runtime.onConnect.addListener((port) => {
  if (port.sender?.id !== chrome.runtime.id) return port.disconnect();
  if (port.name === "x-tab") {
    const tabId = port.sender?.tab?.id;
    const url = port.sender?.tab?.url ?? port.sender?.url ?? "";
    if (tabId === undefined || !url.startsWith("https://x.com/")) return port.disconnect();
    tab(tabId).port = port;
    lastXTab = tabId;
    port.onMessage.addListener((m: { type?: string; obs?: Observation }) => {
      if (m?.type === "obs" && m.obs) onObservation(tabId, m.obs);
    });
    port.onDisconnect.addListener(() => {
      if (tabs.get(tabId)?.port === port) tab(tabId).port = undefined;
    });
    return;
  }
  if (port.name === "popup" && port.sender?.url?.startsWith(chrome.runtime.getURL(""))) {
    popups.add(port);
    port.onDisconnect.addListener(() => popups.delete(port));
    port.postMessage(ui);
    port.onMessage.addListener((cmd: PopupCommand) => void command(cmd));
  }
});

async function command(cmd: PopupCommand): Promise<void> {
  switch (cmd.type) {
    case "refresh":
      return refresh(cmd.tabId);
    case "pair":
      return pair();
    case "pairCode":
      pairing?.code?.(cmd.code);
      return;
    case "pairCancel":
      pairing?.abort.abort();
      return;
    case "start":
      return start(cmd.tabId, cmd.collection);
    case "pause":
      return run?.pause();
    case "cancel":
      return run?.cancel();
    case "setBudget":
      await budget.setLimit(cmd.limit);
      return refresh();
  }
}

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  if (lastXTab === tabId) lastXTab = undefined;
  if (run && runTab === tabId) void run.tabClosed();
});
