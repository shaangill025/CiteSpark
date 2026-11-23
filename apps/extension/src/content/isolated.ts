// Isolated-world content script on https://x.com: relays the page observer's reports to the service
// worker and scrolls when asked. It reads no cookies, storage, or headers (SEC-04).
import { OBSERVATION_TAG } from "../shared/constants.ts";
import type { TabCommand } from "../shared/messages.ts";

const MAX_BODY_CHARS = 4 * 1024 * 1024;
let port: chrome.runtime.Port | undefined;

function connect(): chrome.runtime.Port {
  const p = chrome.runtime.connect({ name: "x-tab" });
  p.onMessage.addListener((m: TabCommand) => {
    if (m?.type === "scroll") {
      // Nudge up, then to the bottom, so X's infinite loader sees the end again even when the
      // page did not grow (for example after a rate-limited request).
      window.scrollBy({ top: -400, behavior: "instant" });
      requestAnimationFrame(() =>
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }),
      );
    }
  });
  p.onDisconnect.addListener(() => {
    if (port === p) port = undefined;
  });
  return p;
}

function valid(o: unknown): boolean {
  if (typeof o !== "object" || o === null) return false;
  const v = o as Record<string, unknown>;
  if (!["page", "viewer", "folders"].includes(v["kind"] as string)) return false;
  if (typeof v["status"] !== "number" || typeof v["tooLarge"] !== "boolean") return false;
  const body = v["body"];
  return body === null || (typeof body === "string" && body.length <= MAX_BODY_CHARS);
}

window.addEventListener("message", (e: MessageEvent) => {
  if (e.source !== window || e.origin !== location.origin) return;
  const d = e.data as { tag?: unknown; obs?: unknown } | null;
  if (!d || d.tag !== OBSERVATION_TAG || !valid(d.obs)) return;
  port ??= connect();
  try {
    port.postMessage({ type: "obs", obs: d.obs });
  } catch {
    port = connect();
    port.postMessage({ type: "obs", obs: d.obs });
  }
});

port = connect();
