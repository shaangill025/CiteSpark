import { describe, expect, it } from "vitest";
import { extractLinks, extractPage } from "./index.ts";

describe("extractLinks", () => {
  it("finds unique links, trims punctuation, drops fragments, classifies X posts", () => {
    const links = extractLinks(
      "see https://example.com/a. and (https://example.com/b_(x)) then https://example.com/a#frag, " +
        "https://x.com/someone/status/1234567890123456789?s=20 and https://twitter.com/i/web/status/42 ftp://nope.test/x",
    );
    expect(links).toEqual([
      { url: "https://example.com/a", kind: "web" },
      { url: "https://example.com/b_(x)", kind: "web" },
      {
        url: "https://x.com/someone/status/1234567890123456789?s=20",
        kind: "x_post",
        platformId: "1234567890123456789",
      },
      { url: "https://twitter.com/i/web/status/42", kind: "x_post", platformId: "42" },
    ]);
  });

  it("returns nothing for text without links", () => {
    expect(extractLinks("no links here")).toEqual([]);
  });
});

describe("extractPage", () => {
  const html = `<!doctype html><html><head><title> Fallback &amp; Title </title>
    <meta property="og:title" content="OG &quot;Title&quot;">
    <link rel="canonical" href="/canon?x=1#f"><style>p{color:red}</style></head>
    <body><script>alert(1)</script><!-- hidden --><p>Hello&nbsp;<b>world</b> &#x263A;</p>
    <p onclick="x()">Second\u0000 para\u202e</p><noscript>no</noscript></body></html>`;

  it("extracts metadata and strips markup, scripts and control characters", () => {
    const p = extractPage(html, "text/html", "https://example.com/start");
    expect(p.title).toBe('OG "Title"');
    expect(p.canonicalUrl).toBe("https://example.com/canon?x=1");
    expect(p.text).toBe("Hello world \u263a Second para");
    expect(p.text).not.toMatch(/[<>]|alert|hidden/);
    expect(p.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("falls back to <title>, ignores non-http canonical, handles plain text", () => {
    const p = extractPage(
      '<title>Only</title><link rel="canonical" href="javascript:x">body',
      "text/html",
      "https://e.com/",
    );
    expect(p).toMatchObject({ title: "Only", canonicalUrl: null });
    expect(extractPage("a\n\n b", "text/plain", "https://e.com/").text).toBe("a b");
  });
});
