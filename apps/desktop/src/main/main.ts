import {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  session,
  utilityProcess,
  type WebContents,
} from "electron";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SUPPORTED_VERSIONS } from "@citspark/protocol";
import { helloVersion, parseRendererRequest, RendererBridge } from "./bridge.ts";
import {
  APP_ENTRY_URL,
  APP_SCHEME,
  CONTENT_SECURITY_POLICY,
  isAllowedRequestUrl,
  isTrustedSender,
  resolveAppAsset,
} from "./security.ts";
import {
  CoreSupervisor,
  DEFAULT_SUPERVISOR_LIMITS,
  type CoreChild,
  type CoreState,
} from "./supervisor.ts";
import { CHANNELS } from "../shared/channels.ts";

// Main process (ADR 0001). It owns windows and the core's lifecycle, and relays validated renderer requests
// to the core's utility process. It holds no library state itself.

const CORE_VERSION = app.getVersion();
const APP_ROOT = app.getAppPath();
const RENDERER_ROOT = join(APP_ROOT, "renderer");

// No GPU-process crash reporter uploads, no component updates, no background networking (no startup network).
app.commandLine.appendSwitch("disable-background-networking");
app.commandLine.appendSwitch("disable-component-update");
app.commandLine.appendSwitch("disable-domain-reliability");
app.commandLine.appendSwitch("disable-breakpad");

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
      stream: false,
    },
  },
]);

if (!app.requestSingleInstanceLock()) app.quit();

let mainWindow: BrowserWindow | undefined;
let lastState: CoreState = { state: "stopped" };
let helloSent = false;
let protocolVersion: number | undefined;

const bridge = new RendererBridge({ send: (id, body) => supervisor.send(id, body) });
// Envelope IDs below 0 are the shell's own hello; the bridge uses positive IDs.
let helloId = -1;

const supervisor = new CoreSupervisor({
  ...DEFAULT_SUPERVISOR_LIMITS,
  spawn: spawnCore,
  onState: (state) => {
    if (state.state !== "ready") {
      bridge.failAll("The Citspark core is not running.");
      protocolVersion = undefined;
      helloSent = false;
    }
    lastState = state;
    if (state.state === "ready") sayHello();
    else publish();
  },
  onReply: (id, body) => {
    if (id === helloId) {
      const version = helloVersion(body);
      if (version !== undefined) {
        protocolVersion = version;
        bridge.setVersion(version);
      } else {
        lastState = {
          state: "failed",
          code: "incompatible",
          message: "This window and the core cannot talk to each other.",
        };
      }
      publish();
      return;
    }
    bridge.deliver(id, body);
  },
});

function sayHello(): void {
  if (helloSent) return;
  helloSent = true;
  helloId -= 1;
  if (!supervisor.send(helloId, { type: "ui.hello", versions: { ...SUPPORTED_VERSIONS } }))
    publish();
}

/** The renderer only ever sees this summary of the core's state. */
function publicState(): Record<string, unknown> {
  const s = lastState;
  if (s.state === "ready") {
    if (protocolVersion === undefined) return { state: "starting" };
    return {
      state: "ready",
      coreVersion: s.coreVersion,
      schemaVersion: s.schemaVersion,
      protocolVersion,
    };
  }
  if (s.state === "failed") return { state: "failed", code: s.code, message: s.message };
  if (s.state === "restarting") return { state: "restarting", attempt: s.attempt };
  return { state: s.state };
}

function publish(): void {
  const wc = mainWindow?.webContents;
  if (wc && !wc.isDestroyed()) wc.send(CHANNELS.statusChanged, publicState());
}

function spawnCore(): CoreChild {
  const dataDir = join(app.getPath("userData"), "library");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const child = utilityProcess.fork(
    join(APP_ROOT, "dist", "core.cjs"),
    [`--data-dir=${dataDir}`, `--core-version=${CORE_VERSION}`],
    {
      serviceName: "Citspark Core",
      stdio: "ignore",
    },
  );
  return {
    get pid() {
      return child.pid;
    },
    post: (m) => child.postMessage(m),
    onMessage: (cb) => void child.on("message", cb),
    onExit: (cb) => void child.once("exit", (code) => cb(code)),
    kill: () => void child.kill(),
  };
}

function guardIpc(event: Electron.IpcMainInvokeEvent): void {
  if (event.sender !== mainWindow?.webContents || !isTrustedSender(event.senderFrame)) {
    throw new Error("Request refused.");
  }
}

function registerIpc(): void {
  ipcMain.handle(CHANNELS.status, (event) => {
    guardIpc(event);
    return publicState();
  });
  ipcMain.handle(CHANNELS.request, (event, input: unknown) => {
    guardIpc(event);
    const parsed = parseRendererRequest(input);
    if (!parsed.ok)
      return {
        v: protocolVersion ?? SUPPORTED_VERSIONS.max,
        id: null,
        ok: false,
        error: parsed.error,
      };
    return bridge.request(parsed.value);
  });
  ipcMain.handle(CHANNELS.restart, (event) => {
    guardIpc(event);
    supervisor.retry();
    return publicState();
  });
}

/** Applied to every session, including ones created later (for example a partition). */
function hardenSession(ses: Electron.Session): void {
  ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  ses.setDisplayMediaRequestHandler((_req, callback) => callback({}));
  // On Linux (and Windows) Chromium downloads Hunspell dictionaries from redirector.gvt1.com when a spellchecker
  // starts, which is a startup connection to a third party (SEC-05). Disable spellchecking and point any
  // dictionary download at a URL that cannot resolve off-device. Offline bundled dictionaries are a later choice.
  ses.setSpellCheckerEnabled(false);
  ses.setSpellCheckerLanguages([]);
  ses.setSpellCheckerDictionaryDownloadURL("http://127.0.0.1:9/");
  ses.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !isAllowedRequestUrl(details.url) }),
  );
  ses.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        "Content-Security-Policy": [CONTENT_SECURITY_POLICY],
        "X-Content-Type-Options": ["nosniff"],
      },
    });
  });
}

/** Serves the renderer from the app bundle. Only the default session gets the app scheme. */
function serveApp(): void {
  session.defaultSession.protocol.handle(APP_SCHEME, (request) => {
    const asset = resolveAppAsset(RENDERER_ROOT, request.url);
    if (!asset || request.method !== "GET") return new Response("Not found", { status: 404 });
    return new Response(readFileSync(asset.file), {
      headers: {
        "Content-Type": asset.mimeType,
        "Content-Security-Policy": CONTENT_SECURITY_POLICY,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  });
}

function hardenContents(contents: WebContents): void {
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.on("will-navigate", (event, url) => {
    if (url !== contents.getURL()) event.preventDefault();
  });
  contents.on("will-redirect", (event) => event.preventDefault());
  contents.on("will-attach-webview", (event) => event.preventDefault());
  contents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame) event.preventDefault();
  });
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 960,
    height: 680,
    title: "Citspark",
    show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: join(APP_ROOT, "dist", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      spellcheck: false,
      navigateOnDragDrop: false,
      safeDialogs: true,
      devTools: !app.isPackaged,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow?.show());
  mainWindow.webContents.on("did-finish-load", publish);
  mainWindow.on("closed", () => {
    mainWindow = undefined;
  });
  void mainWindow.loadURL(APP_ENTRY_URL);
}

app.on("web-contents-created", (_event, contents) => hardenContents(contents));
app.on("session-created", (ses) => hardenSession(ses));
app.on("second-instance", () => {
  if (mainWindow?.isMinimized()) mainWindow.restore();
  mainWindow?.focus();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting) return;
  event.preventDefault();
  quitting = true;
  // Close the library and reap the core before the app exits.
  void supervisor.stop().finally(() => app.quit());
});
app.on("window-all-closed", () => app.quit());

void app.whenReady().then(() => {
  hardenSession(session.defaultSession);
  serveApp();
  registerIpc();
  supervisor.start();
  createWindow();
});
