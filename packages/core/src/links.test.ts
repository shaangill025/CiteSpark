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
  describe("HTML-aware metadata", () => {
    const at = "https://e.com/article";

    it("ignores title, canonical and og:title text inside script and style raw text", () => {
      const p = extractPage(
        "<html><head><script>const example=`<title>Fake</title>" +
          '<link rel="canonical" href="/wrong"><meta property="og:title" content="Fake OG">`;</script>' +
          '<style>/* <link rel="canonical" href="/wrong-style"> <title>Styled</title> */</style>' +
          '<title>Real</title><link rel="canonical" href="/real"></head><body><p>Real article</p></body></html>',
        "text/html",
        at,
      );
      expect(p).toMatchObject({
        title: "Real",
        canonicalUrl: "https://e.com/real",
        text: "Real article",
      });
    });

    it("ignores metadata inside comments, textarea, noscript and template content", () => {
      const p = extractPage(
        '<head><!-- <link rel="canonical" href="/c"><title>C</title> -->' +
          '<noscript><link rel="canonical" href="/n"><meta property="og:title" content="N"></noscript>' +
          '<template><link rel="canonical" href="/t"><meta property="og:title" content="T"></template>' +
          '<link rel="canonical" href="/real"></head>' +
          "<body><textarea><title>Area</title></textarea><p>x</p><title>Body title</title></body>",
        "text/html",
        at,
      );
      expect(p.canonicalUrl).toBe("https://e.com/real");
      expect(p.title).toBe("Body title");
    });

    it("reads unquoted, single-quoted and entity-encoded attributes", () => {
      expect(
        extractPage(
          "<title>Real</title><link rel=canonical href=/real><p>body</p>",
          "text/html",
          at,
        ).canonicalUrl,
      ).toBe("https://e.com/real");
      const q = extractPage(
        "<link rel='canonical' href='/a?x=1&amp;y=2'><meta property='og:title' content='Single &amp; quoted'><p>b</p>",
        "text/html",
        at,
      );
      expect(q).toMatchObject({
        canonicalUrl: "https://e.com/a?x=1&y=2",
        title: "Single & quoted",
      });
    });

    it("matches rel as a case-insensitive token list, not a substring", () => {
      const page = (rel: string) =>
        extractPage(`<link rel="${rel}" href="/c"><p>b</p>`, "text/html", at).canonicalUrl;
      expect(page("alternate  Canonical")).toBe("https://e.com/c");
      expect(page("CANONICAL")).toBe("https://e.com/c");
      expect(page("canonicalx")).toBeNull();
      expect(page("not-canonical")).toBeNull();
      expect(page("alternate")).toBeNull();
    });

    it("uses the first valid head canonical and ignores canonical links in the body", () => {
      expect(
        extractPage(
          '<head><link rel="canonical" href=""><link rel="canonical" href="mailto:x@e.com">' +
            '<link rel="canonical" href="/first"><link rel="canonical" href="/second"></head><p>b</p>',
          "text/html",
          at,
        ).canonicalUrl,
      ).toBe("https://e.com/first");
      expect(
        extractPage('<p>user content</p><link rel="canonical" href="/injected">', "text/html", at)
          .canonicalUrl,
      ).toBeNull();
    });

    it("resolves relative canonical URLs against the document base URL", () => {
      expect(
        extractPage(
          '<head><base href="https://e.com/docs/"><link rel="canonical" href="page"></head><p>b</p>',
          "text/html",
          at,
        ).canonicalUrl,
      ).toBe("https://e.com/docs/page");
    });

    it("uses only an HTML title element, never an SVG title", () => {
      const p = extractPage(
        "<body><svg><title>Icon</title></svg><p>Body</p></body>",
        "text/html",
        at,
      );
      expect(p).toMatchObject({ title: null, text: "Body" });
    });

    it("ignores og:title meta tags outside the head and empty og:title content", () => {
      const p = extractPage(
        '<head><meta property="og:title" content="  "><title>Fallback</title></head>' +
          '<body><meta property="og:title" content="Body OG"><p>b</p></body>',
        "text/html",
        at,
      );
      expect(p.title).toBe("Fallback");
    });
  });
});
