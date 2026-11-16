import { createHash } from "node:crypto";
import { parse, type DefaultTreeAdapterTypes } from "parse5";

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

/** Text and metadata come from a spec-compliant HTML parse (parse5), not from markup patterns. */
export const EXTRACTION_METHOD = "html-dom-v1";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const HTML_NS = "http://www.w3.org/1999/xhtml";

/** Subtrees that never contribute page text: metadata, raw-text containers and foreign content. */
const SKIP_TEXT = new Set([
  "head",
  "title",
  "script",
  "style",
  "noscript",
  "template",
  "iframe",
  "noembed",
  "noframes",
  "object",
  "svg",
  "math",
]);

/** Elements that separate words in the extracted text. */
const BLOCK = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "br",
  "caption",
  "dd",
  "details",
  "dialog",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hr",
  "li",
  "main",
  "nav",
  "ol",
  "option",
  "p",
  "pre",
  "section",
  "summary",
  "table",
  "td",
  "th",
  "tr",
  "ul",
]);

const CONTROL_RE =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function clean(s: string): string {
  return s.replace(CONTROL_RE, "").replace(/\s+/g, " ").trim();
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

/** HTML-namespace elements in tree order. Template contents are a separate fragment and are never visited. */
function* htmlElements(node: ParentNode): Generator<Element> {
  for (const child of node.childNodes) {
    if (!isElement(child)) continue;
    if (child.namespaceURI === HTML_NS) yield child;
    yield* htmlElements(child);
  }
}

function attr(el: Element, name: string): string | null {
  return el.attrs.find((a) => a.name === name && !a.namespace)?.value ?? null;
}

function childText(el: Element): string {
  return el.childNodes.map((c) => ("value" in c && c.nodeName === "#text" ? c.value : "")).join("");
}

function httpUrl(raw: string, base: string): URL | null {
  try {
    const u = new URL(raw, base);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/** The document base URL: the first `<base href>` when it is http(s), else the fetched URL. */
function documentBase(doc: ParentNode, finalUrl: string): string {
  for (const el of htmlElements(doc)) {
    if (el.tagName !== "base") continue;
    const href = attr(el, "href");
    if (href === null) continue;
    return httpUrl(href, finalUrl)?.href ?? finalUrl;
  }
  return finalUrl;
}

/** First `<link rel=canonical>` in the head (rel is an ASCII-whitespace token list) with an http(s) href. */
function canonicalOf(head: Element | undefined, base: string): string | null {
  if (!head) return null;
  for (const el of htmlElements(head)) {
    if (el.tagName !== "link") continue;
    const rel = (attr(el, "rel") ?? "").toLowerCase().split(/[\t\n\f\r ]+/);
    if (!rel.includes("canonical")) continue;
    const href = attr(el, "href");
    if (href === null || href.trim() === "") continue;
    const u = httpUrl(href, base);
    if (u) {
      u.hash = "";
      return u.href;
    }
  }
  return null;
}

/** The first non-empty `<meta property="og:title">` in the head, else the document's first HTML `<title>`. */
function titleOf(doc: ParentNode, head: Element | undefined): string | null {
  for (const el of head ? htmlElements(head) : []) {
    if (el.tagName !== "meta" || attr(el, "property")?.trim().toLowerCase() !== "og:title")
      continue;
    const content = clean(attr(el, "content") ?? "");
    if (content) return content;
  }
  for (const el of htmlElements(doc)) {
    if (el.tagName === "title") return clean(childText(el)) || null;
  }
  return null;
}

function collectText(node: ParentNode, out: string[]): void {
  for (const child of node.childNodes) {
    if (child.nodeName === "#text" && "value" in child) {
      out.push(child.value);
    } else if (isElement(child) && !SKIP_TEXT.has(child.tagName)) {
      const block = BLOCK.has(child.tagName);
      if (block) out.push("\n");
      collectText(child, out);
      if (block) out.push("\n");
    }
  }
}

/** Extract title, canonical URL and sanitized text from decoded HTML or plain text. */
export function extractPage(body: string, contentType: string, finalUrl: string): PageContent {
  let title: string | null = null;
  let canonicalUrl: string | null = null;
  let text: string;
  if (contentType === "text/plain") {
    text = clean(body);
  } else {
    // Parsed as a browser would (scripting enabled), so script, style, comment, noscript and
    // attribute contents are never mistaken for metadata or text elements.
    const doc = parse(body);
    const html = doc.childNodes.find((n): n is Element => isElement(n) && n.tagName === "html");
    const head = html?.childNodes.find((n): n is Element => isElement(n) && n.tagName === "head");
    title = titleOf(doc, head);
    canonicalUrl = canonicalOf(head, documentBase(doc, finalUrl));
    const parts: string[] = [];
    collectText(doc, parts);
    text = clean(parts.join(""));
  }
  return {
    title,
    canonicalUrl,
    text,
    contentHash: createHash("sha256").update(text).digest("hex"),
    extractionMethod: EXTRACTION_METHOD,
  };
}
