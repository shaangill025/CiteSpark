import { createHash } from "node:crypto";

/** ENR-01/ENR-02: link extraction and page metadata. No recursive crawling happens here or downstream. */

export interface ExtractedLink {
  url: string;
  kind: "x_post" | "web";
  /** Platform status ID for X post links (kept as a string; 19-digit IDs exceed Number.MAX_SAFE_INTEGER). */
  platformId?: string;
}

const URL_RE = /https?:\/\/[^\s<>"'`]+/gi;
const X_HOSTS = new Set([
  "x.com",
  "www.x.com",
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
]);

function trimTrailing(u: string): string {
  let s = u;
  for (;;) {
    const last = s.at(-1);
    if (last === undefined) return s;
    if (/[.,;:!?'"\u2026\u201d\u2019]/.test(last)) s = s.slice(0, -1);
    else if (last === ")" && (s.match(/\(/g)?.length ?? 0) < (s.match(/\)/g)?.length ?? 0))
      s = s.slice(0, -1);
    else return s;
  }
}

/** Identify a direct X post URL; returns its status ID. */
export function xPostId(url: URL): string | null {
  if (!X_HOSTS.has(url.hostname.toLowerCase())) return null;
  const m = /^\/(?:[A-Za-z0-9_]{1,15}|i\/web)\/status\/(\d{1,25})(?:\/|$)/.exec(url.pathname);
  return m?.[1] ?? null;
}

/** Find unique http(s) links in text, in first-seen order, fragments dropped. */
export function extractLinks(text: string): ExtractedLink[] {
  const seen = new Set<string>();
  const out: ExtractedLink[] = [];
  for (const match of text.matchAll(URL_RE)) {
    let url: URL;
    try {
      url = new URL(trimTrailing(match[0]));
    } catch {
      continue;
    }
    url.hash = "";
    const href = url.href;
    if (seen.has(href)) continue;
    seen.add(href);
    const id = xPostId(url);
    out.push(id ? { url: href, kind: "x_post", platformId: id } : { url: href, kind: "web" });
  }
  return out;
}

export interface PageContent {
  title: string | null;
  canonicalUrl: string | null;
  /** Plain text only; markup, scripts, styles and control characters are removed (ENR-03 sanitization). */
  text: string;
  contentHash: string;
  extractionMethod: string;
}

export const EXTRACTION_METHOD = "html-text-v1";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === "#") {
      const code =
        body[1]?.toLowerCase() === "x" ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : "";
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

const CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function clean(s: string): string {
  return s.replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
}

function metaContent(html: string, attr: "property" | "name", key: string): string | null {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const a = new RegExp(`\\b${attr}\\s*=\\s*["']${key}["']`, "i").test(tag);
    if (!a) continue;
    const c = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const v = c?.[1] ?? c?.[2];
    if (v) return clean(decodeEntities(v));
  }
  return null;
}

function canonicalOf(html: string, base: string): string | null {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']?canonical["']?/i.test(tag)) continue;
    const h = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
    const raw = h?.[1] ?? h?.[2];
    if (!raw) continue;
    try {
      const u = new URL(decodeEntities(raw), base);
      if (u.protocol === "http:" || u.protocol === "https:") {
        u.hash = "";
        return u.href;
      }
    } catch {
      /* ignore malformed canonical */
    }
  }
  return null;
}

/** Extract title, canonical URL and sanitized text from fetched HTML or plain text. */
export function extractPage(body: string, contentType: string, finalUrl: string): PageContent {
  let title: string | null = null;
  let canonicalUrl: string | null = null;
  let text: string;
  if (contentType === "text/plain") {
    text = clean(body);
  } else {
    const head = body.replace(/<!--[\s\S]*?-->/g, "");
    title =
      metaContent(head, "property", "og:title") ??
      (() => {
        const t = /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(head);
        return t?.[1] ? clean(decodeEntities(t[1])) || null : null;
      })();
    canonicalUrl = canonicalOf(head, finalUrl);
    text = clean(
      decodeEntities(
        head
          .replace(/<(script|style|noscript|template|svg|head|title)\b[\s\S]*?<\/\1\s*>/gi, " ")
          .replace(/<\/?(p|div|br|li|h[1-6]|tr|section|article|blockquote)\b[^>]*>/gi, "\n")
          .replace(/<[^>]*>/g, " "),
      ),
    );
  }
  return {
    title,
    canonicalUrl,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    extractionMethod: EXTRACTION_METHOD,
  };
}
