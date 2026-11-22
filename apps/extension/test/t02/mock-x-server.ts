// Synthetic mock of x.com for the T02 harness. Served through Playwright request interception, so the
// browser never resolves or contacts the real x.com. The mock page behaves like X's web app: it sends
// its own GraphQL requests with session headers (synthetic canaries) and loads more on scroll.
import type { BrowserContext, Route } from "playwright";
import {
  OTHER_ACCOUNT,
  SYNTH_ACCOUNT,
  SYNTH_HANDLE,
  bookmarksBody,
  viewerBody,
  type PageSpec,
} from "../mock-x/bodies.ts";

export const CANARY = {
  bearer: "SYNTHCANARYBEARER0000000000000000000000000000AAAA",
  csrf: "synthcanarycsrf0a1b2c3d4e5f60718293a4b5c6d7e8f9",
  authToken: "synthcanaryauthtoken9f8e7d6c5b4a",
} as const;

export interface Fault {
  status: number;
  retryAfter?: string;
}

export interface Scenario {
  pages: PageSpec[];
  /** Faults served, in order, before page `index` succeeds. */
  faults?: Record<number, Fault[]>;
  /** Page whose bottom cursor points back to the previous page's cursor (a cursor loop). */
  loopAt?: number;
  /** After this many viewer requests, the viewer reports another account. */
  switchAccountAfter?: number;
  /** Called when page `index` is served (before the response). */
  onPage?: (index: number) => void;
}

export interface Recorded {
  op: string;
  cursor: string | null;
  status: number;
  /** Header set by the mock page's own code on every request it issues. */
  issuedByPage: boolean;
  authorization: string | null;
  csrf: string | null;
  at: number;
}

const PAGE_HTML = (timeline: boolean) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Synthetic X mock</title></head>
<body><main id="feed" style="min-height:1400px"></main><div id="end" style="height:200px"></div>
<script>
(() => {
  const C = ${JSON.stringify({ bearer: CANARY.bearer, csrf: CANARY.csrf })};
  document.cookie = "ct0=" + C.csrf + "; Secure; SameSite=Lax; Path=/";
  let seq = 0, next = null, started = false, loading = false, done = false, failed = null;
  const v = (o) => encodeURIComponent(JSON.stringify(o));
  const headers = () => ({ authorization: "Bearer " + C.bearer, "x-csrf-token": C.csrf, "x-mock-seq": String(++seq) });
  function viewer() {
    return fetch("/i/api/graphql/SynthQueryViewer/Viewer?variables=" + v({}), { headers: headers(), credentials: "include" });
  }
  function load(cursor) {
    if (loading || done) return;
    loading = true; started = true;
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/i/api/graphql/SynthQueryBookmarks/Bookmarks?variables=" + v(cursor ? { count: 20, cursor } : { count: 20 }));
    for (const [k, val] of Object.entries(headers())) xhr.setRequestHeader(k, val);
    xhr.withCredentials = true;
    xhr.onloadend = () => {
      loading = false;
      if (xhr.status !== 200) { failed = cursor; return; }
      failed = null;
      let body; try { body = JSON.parse(xhr.responseText); } catch { done = true; return; }
      const ins = body?.data?.bookmark_timeline_v2?.timeline?.instructions ?? [];
      let bottom = null;
      for (const i of ins) for (const e of i.entries ?? []) {
        if (e.content?.cursorType === "Bottom") bottom = e.content.value;
        else if (e.content?.itemContent) {
          const d = document.createElement("article");
          d.style.height = "300px";
          d.textContent = e.content.itemContent.tweet_results?.result?.legacy?.full_text?.slice(0, 80) ?? "unavailable";
          document.getElementById("feed").appendChild(d);
        }
      }
      if (bottom === null) done = true; else next = bottom;
      viewer();
    };
    xhr.send();
  }
  window.addEventListener("scroll", () => {
    if (window.innerHeight + window.scrollY < document.documentElement.scrollHeight - 100) return;
    if (!started) return;
    load(failed ?? next);
  });
  viewer().finally(() => { if (${timeline}) load(null); });
  fetch("/i/api/graphql/SynthQueryFolders/BookmarkFoldersSlice?variables=" + v({}), { headers: headers(), credentials: "include" });
})();
</script></body></html>`;

/** Mock X: each document load starts a new generation with fresh cursors, as X does (ADR 0005). */
export class MockX {
  scenario: Scenario = { pages: [] };
  generation = 0;
  viewerCalls = 0;
  readonly recorded: Recorded[] = [];
  readonly foreignHosts = new Set<string>();
  #faults = new Map<number, Fault[]>();

  set(s: Scenario): void {
    this.scenario = s;
    this.viewerCalls = 0;
    this.recorded.length = 0;
    this.#faults = new Map(Object.entries(s.faults ?? {}).map(([k, v]) => [Number(k), [...v]]));
  }

  cursor(gen: number, index: number): string {
    return `G${gen}_SYNTH_CURSOR_${index}`;
  }

  async install(context: BrowserContext): Promise<void> {
    // Web traffic only. A "**/*" route also intercepts the extension's own chrome-extension://
    // resources, and aborting popup.js left the popup stuck on "checking" (the web block stays
    // total: every http(s) request is answered here or aborted).
    await context.route(
      (url) => url.protocol === "http:" || url.protocol === "https:",
      (route) => this.#handle(route),
    );
  }

  async #handle(route: Route): Promise<void> {
    const req = route.request();
    const url = new URL(req.url());
    if (url.hostname !== "x.com" || url.protocol !== "https:") {
      this.foreignHosts.add(url.host);
      return route.abort("blockedbyclient");
    }
    if (req.resourceType() === "document") {
      this.generation++;
      return route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        headers: {
          "set-cookie": `auth_token=${CANARY.authToken}; Secure; HttpOnly; Path=/; SameSite=Lax`,
        },
        body: PAGE_HTML(url.pathname.startsWith("/i/bookmarks")),
      });
    }
    const op = /\/i\/api\/graphql\/[^/]+\/([A-Za-z]+)$/.exec(url.pathname)?.[1];
    if (!op) return route.fulfill({ status: 404, body: "" });
    const vars = JSON.parse(url.searchParams.get("variables") ?? "{}") as { cursor?: string };
    const h = req.headers();
    const rec: Recorded = {
      op,
      cursor: vars.cursor ?? null,
      status: 200,
      issuedByPage: typeof h["x-mock-seq"] === "string",
      authorization: h["authorization"] ?? null,
      csrf: h["x-csrf-token"] ?? null,
      at: Date.now(),
    };
    this.recorded.push(rec);
    const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => {
      rec.status = status;
      return route.fulfill({
        status,
        contentType: "application/json",
        headers,
        body: JSON.stringify(body),
      });
    };
    if (op === "Viewer") {
      this.viewerCalls++;
      const after = this.scenario.switchAccountAfter;
      const other = after !== undefined && this.viewerCalls > after;
      return json(
        other
          ? viewerBody(OTHER_ACCOUNT, "synth_mallory")
          : viewerBody(SYNTH_ACCOUNT, SYNTH_HANDLE),
      );
    }
    if (op === "BookmarkFoldersSlice") {
      return json({
        data: {
          viewer: {
            user_results: {
              result: {
                bookmark_collections_slice: {
                  items: [{ id: "1800000000000000001", name: "Synthetic folder" }],
                },
              },
            },
          },
        },
      });
    }
    if (op !== "Bookmarks") return json({ errors: [{ message: "unknown" }] }, 400);
    const m = vars.cursor ? /^G(\d+)_SYNTH_CURSOR_(\d+)$/.exec(vars.cursor) : null;
    if (vars.cursor && !m) return json({ errors: [{ message: "bad cursor" }] }, 400);
    const gen = m ? Number(m[1]) : this.generation;
    const index = m ? Number(m[2]) : 0;
    const fault = this.#faults.get(index)?.shift();
    if (fault) {
      return json({ errors: [{ message: "synthetic fault" }] }, fault.status, {
        ...(fault.retryAfter ? { "retry-after": fault.retryAfter } : {}),
      });
    }
    const spec = this.scenario.pages[index];
    if (!spec) return json({ errors: [{ message: "no such page" }] }, 400);
    this.scenario.onPage?.(index);
    let next: string | null = spec.next === null ? null : this.cursor(gen, index + 1);
    if (this.scenario.loopAt === index && index > 0) next = this.cursor(gen, index - 1);
    return json(bookmarksBody({ ...spec, next }));
  }
}
