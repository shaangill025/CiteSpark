// Popup controls: pairing, start, pause, cancel, and the daily budget. It renders state that the
// service worker publishes; it holds no secrets and never talks to X or the desktop itself.
import type { PopupCommand, UiState } from "../shared/messages.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const port = chrome.runtime.connect({ name: "popup" });
const send = (c: PopupCommand) => port.postMessage(c);

const RUN_TEXT: Record<string, string> = {
  starting: "Starting…",
  capturing: "Capturing",
  catching_up: "Catching up: re-reading pages already saved",
  backing_off: "Waiting before the next page (rate limit or error)",
  complete: "Complete: reached the end of the collection",
  partial: "Partial: reached the end, but some posts or threads were unavailable",
  paused: "Paused",
  cancelled: "Cancelled. Pages already saved are kept.",
  auth_required: "Sign in to X, then start again",
  rate_limited: "X is limiting requests. Try again later.",
  failed: "Stopped with an error",
  desktop_unavailable: "Lost the connection to Citspark. Nothing more was saved.",
};

const REASON_TEXT: Record<string, string> = {
  user_pause: "you paused it",
  user_cancel: "you cancelled it",
  daily_budget: "the daily page budget is used up",
  unsupported_schema: "X changed its page format; capture is paused until Citspark is updated",
  response_too_large: "X sent a response larger than the limit",
  no_progress: "X stopped loading more pages; the end was not confirmed",
  account_mismatch: "a different X account is signed in",
  account_unknown: "the signed-in X account could not be detected",
  tab_closed: "the X tab was closed",
  disk_full: "the disk is full",
  cursor_loop: "X repeated a page",
  checkpoint_corrupt: "Citspark could not read its saved progress for this capture",
  transient_errors: "X kept returning errors",
  lease_lost: "another capture took over",
  no_x_tab: "open x.com in a tab first",
};

function render(s: UiState): void {
  const link = $("link");
  link.dataset["state"] = s.link;
  link.textContent = s.linkMessage ?? "Checking Citspark…";
  const p = s.pairing;
  $("pairing").hidden = !p?.awaitingDesktopCode;
  $("client-code").textContent = p?.code ?? "";
  $("pair-error").textContent = p?.error ?? "";
  $<HTMLButtonElement>("pair").hidden = s.link === "ready" || Boolean(p?.awaitingDesktopCode);
  $("account").textContent = s.account
    ? `Signed in to X as @${s.account.handle}`
    : s.xTab
      ? "Waiting to see which X account is signed in."
      : "Open x.com in a tab and sign in.";
  const select = $<HTMLSelectElement>("collection");
  const keep = select.value;
  for (const o of [...select.options]) if (o.value.startsWith("bookmark_folder:")) o.remove();
  for (const f of s.folders)
    select.add(new Option(`Folder: ${f.name}`, `bookmark_folder:${f.folderId}`));
  select.value = [...select.options].some((o) => o.value === keep) ? keep : "bookmarks";
  const r = s.run;
  const running =
    r !== null && ["starting", "capturing", "catching_up", "backing_off"].includes(r.state);
  $<HTMLButtonElement>("start").disabled = running || s.link !== "ready";
  $<HTMLButtonElement>("pause").disabled = !running;
  $<HTMLButtonElement>("cancel").disabled = !running;
  const run = $("run");
  run.dataset["state"] = r?.state ?? "idle";
  if (!r) run.textContent = "No capture running.";
  else {
    const reason = r.reason ? ` (${REASON_TEXT[r.reason] ?? r.reason})` : "";
    const retry = r.retryAt ? ` Retry after ${new Date(r.retryAt).toLocaleTimeString()}.` : "";
    run.textContent = `${RUN_TEXT[r.state] ?? r.state}${reason}. Pages: ${r.pages}, new posts: ${r.newRecords}.${retry}`;
  }
  $("budget").textContent = `${s.budget.used} of ${s.budget.limit} pages used today.`;
  const limit = $<HTMLInputElement>("budget-limit");
  if (document.activeElement !== limit) limit.value = String(s.budget.limit);
}

port.onMessage.addListener((s: UiState) => render(s));
$("pair").addEventListener("click", () => send({ type: "pair" }));
$("confirm-code").addEventListener("click", () =>
  send({ type: "pairCode", code: $<HTMLInputElement>("desktop-code").value }),
);
$("cancel-pair").addEventListener("click", () => send({ type: "pairCancel" }));
$("pause").addEventListener("click", () => send({ type: "pause" }));
$("cancel").addEventListener("click", () => send({ type: "cancel" }));
$("save-budget").addEventListener("click", () =>
  send({ type: "setBudget", limit: Number($<HTMLInputElement>("budget-limit").value) }),
);
$("start").addEventListener("click", async () => {
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  send({
    type: "start",
    tabId: active?.id ?? -1,
    collection: $<HTMLSelectElement>("collection").value,
  });
});
void chrome.tabs
  .query({ active: true, currentWindow: true })
  .then(([t]) => send({ type: "refresh", ...(t?.id === undefined ? {} : { tabId: t.id }) }));
