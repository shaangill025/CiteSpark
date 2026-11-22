import { classifyRequest, collectionKey, type RecognizedRequest } from "@citspark/capture-x";
import type { Observation } from "../background/run.ts";

/** The parts of `window` the observer touches; injectable for tests. */
export interface ObserverWindow {
  location: { href: string };
  fetch: typeof fetch;
  XMLHttpRequest?: typeof XMLHttpRequest;
}

export const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

type Base = Omit<
  Extract<Observation, { kind: "page" }>,
  "status" | "retryAfter" | "body" | "tooLarge"
>;

type Simple = { kind: "viewer" | "folders" };

function base(req: RecognizedRequest): Base | Simple {
  if (req.operation === "page") {
    return { kind: "page", collection: collectionKey(req.collection), cursor: req.cursor };
  }
  return { kind: req.operation };
}

function make(
  b: Base | Simple,
  status: number,
  retryAfter: string | null,
  body: string | null,
  tooLarge: boolean,
): Observation {
  if (b.kind !== "page") return { kind: b.kind, status, body, tooLarge };
  return { ...b, status, retryAfter, body, tooLarge };
}

async function readBounded(
  res: Response,
  max: number,
): Promise<{ body: string | null; tooLarge: boolean }> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    void res.body?.cancel().catch(() => undefined);
    return { body: null, tooLarge: true };
  }
  const reader = res.body?.getReader();
  if (!reader) return { body: "", tooLarge: false };
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      void reader.cancel().catch(() => undefined);
      return { body: null, tooLarge: true };
    }
    parts.push(value);
  }
  const all = new Uint8Array(size);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.byteLength;
  }
  return { body: new TextDecoder().decode(all), tooLarge: false };
}

/**
 * Passive observation of X's own requests in the page context (ADR 0005). It wraps `fetch` and
 * `XMLHttpRequest` only to read the responses of recognized collection and viewer requests; the
 * request, its arguments, and the response handed back to X are never changed. It never reads
 * request headers, cookies, or any response header except Retry-After (SEC-04), and it builds no
 * request of its own. Bodies are bounded; larger ones are reported as too large without content.
 */
export function installObserver(
  win: ObserverWindow,
  emit: (o: Observation) => void,
  opts: { maxBodyBytes?: number } = {},
): void {
  const max = opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const recognize = (raw: string | URL | Request | undefined): Base | Simple | null => {
    try {
      const href =
        typeof raw === "string" ? raw : raw instanceof URL ? raw.href : raw ? raw.url : "";
      const req = classifyRequest(new URL(href, win.location.href).href);
      return req ? base(req) : null;
    } catch {
      return null;
    }
  };

  const origFetch = win.fetch;
  win.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
    const result = origFetch.apply(this, args);
    const b = recognize(args[0]);
    if (b) {
      result.then(
        (res) => {
          let copy: Response;
          try {
            copy = res.clone();
          } catch {
            return;
          }
          const retryAfter = res.headers.get("retry-after");
          const ok = res.status >= 200 && res.status <= 299;
          if (!ok) {
            void copy.body?.cancel().catch(() => undefined);
            emit(make(b, res.status, retryAfter, null, false));
            return;
          }
          readBounded(copy, max).then(
            (r) => emit(make(b, res.status, retryAfter, r.body, r.tooLarge)),
            () => emit(make(b, 0, null, null, false)),
          );
        },
        () => emit(make(b, 0, null, null, false)),
      );
    }
    return result;
  } as typeof fetch;

  const Xhr = win.XMLHttpRequest;
  if (!Xhr) return;
  const urls = new WeakMap<XMLHttpRequest, string>();
  const origOpen = Xhr.prototype.open;
  const origSend = Xhr.prototype.send;
  Xhr.prototype.open = function (this: XMLHttpRequest, ...args: unknown[]) {
    urls.set(this, String(args[1]));
    return (origOpen as (...a: unknown[]) => void).apply(this, args);
  } as typeof origOpen;
  Xhr.prototype.send = function (
    this: XMLHttpRequest,
    ...args: [Document | XMLHttpRequestBodyInit | null | undefined]
  ) {
    const b = recognize(urls.get(this));
    if (b) {
      this.addEventListener("loadend", () => {
        const status = this.status;
        const retryAfter = this.getResponseHeader("retry-after");
        if (status < 200 || status > 299) return emit(make(b, status, retryAfter, null, false));
        let body: string | null = null;
        try {
          if (this.responseType === "" || this.responseType === "text") body = this.responseText;
          else if (this.responseType === "json") body = JSON.stringify(this.response);
        } catch {
          body = null;
        }
        if (body !== null && body.length > max)
          return emit(make(b, status, retryAfter, null, true));
        emit(make(b, status, retryAfter, body, false));
      });
    }
    return origSend.apply(this, args);
  };
}
