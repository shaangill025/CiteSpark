import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureLink, ExtractionPool, type GuardedFetchOptions } from "./index.ts";

let server: Server;
let base: string;
let response: { headers: Record<string, string>; body: Buffer };

const open: GuardedFetchOptions = { allowAddress: (ip) => ip === "127.0.0.1" };
const latin1 = (s: string) => Buffer.from(s, "latin1");
// Unmatched end tags make the parser rescan its open-element stack without pushing anything, so this
// page passes the nesting-work counter; on this hardware it parses for well over ten seconds.
const adversarial = `${"<span>".repeat(6000)}${"</button>".repeat(400_000)}<article>article</article>`;
const serve = (headers: Record<string, string>, body: Buffer | string) => {
  response = { headers, body: typeof body === "string" ? Buffer.from(body, "utf8") : body };
};

beforeEach(async () => {
  serve({ "content-type": "text/html" }, "<p>default</p>");
  server = createServer((_req, res) => res.writeHead(200, response.headers).end(response.body));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  server.closeAllConnections();
  server.close();
});

describe("captureLink text decoding", () => {
  it("decodes the Content-Type charset instead of assuming UTF-8", async () => {
    serve(
      { "content-type": "text/html; charset=iso-8859-1" },
      latin1("<title>Caf\xe9</title><p>Caf\xe9 cr\xe8me</p>"),
    );
    expect(await captureLink(base, open)).toMatchObject({
      ok: true,
      title: "Café",
      text: "Café crème",
    });
    serve({ "content-type": "text/plain; charset=windows-1252" }, latin1("Caf\xe9 \x93q\x94"));
    expect(await captureLink(base, open)).toMatchObject({ ok: true, text: "Café \u201cq\u201d" });
  });

  it("honors an HTML meta charset or http-equiv declaration when the header has none", async () => {
    for (const decl of [
      '<meta charset="windows-1252">',
      "<meta charset=iso-8859-1>",
      '<meta http-equiv="Content-Type" content="text/html; charset=iso-8859-1">',
    ]) {
      serve(
        { "content-type": "text/html" },
        latin1(`<head>${decl}<title>Caf\xe9</title></head><p>Caf\xe9</p>`),
      );
      expect(await captureLink(base, open), decl).toMatchObject({
        ok: true,
        title: "Café",
        text: "Café",
      });
    }
  });

  it("does not take a charset declaration from script text or comments", async () => {
    for (const fake of [
      '<script>const s = `<meta charset="windows-1252">`;</script>',
      '<!-- <meta charset="windows-1252"> -->',
    ]) {
      serve({ "content-type": "text/html" }, latin1(`<head>${fake}</head><p>Caf\xe9</p>`));
      expect(await captureLink(base, open), fake).toMatchObject({
        ok: false,
        reason: "invalid_text_encoding",
      });
    }
  });

  it("lets the Content-Type charset take precedence over a conflicting meta declaration", async () => {
    serve(
      { "content-type": "text/html; charset=utf-8" },
      '<meta charset="iso-8859-1"><p>Café ☕ 𝄞</p>',
    );
    expect(await captureLink(base, open)).toMatchObject({ ok: true, text: "Café ☕ 𝄞" });
  });

  it("follows a byte order mark and preserves Unicode without a declared charset", async () => {
    const utf16 = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from("<p>Café 𝄞</p>", "utf16le"),
    ]);
    serve({ "content-type": "text/html" }, utf16);
    expect(await captureLink(base, open)).toMatchObject({ ok: true, text: "Café 𝄞" });
    serve({ "content-type": "text/plain" }, "naïve ☕ 𝄞");
    expect(await captureLink(base, open)).toMatchObject({ ok: true, text: "naïve ☕ 𝄞" });
  });

  it("reports bytes that are invalid for the effective encoding as an explicit gap", async () => {
    for (const type of ["text/html; charset=utf-8", "text/html", "text/plain"]) {
      serve({ "content-type": type }, latin1("<p>Caf\xe9</p>"));
      const r = await captureLink(base, open);
      expect(r, type).toMatchObject({
        ok: false,
        reason: "invalid_text_encoding",
        httpStatus: 200,
      });
      expect(JSON.stringify(r)).not.toContain("\ufffd");
    }
  });

  it("reports an unknown or unsupported charset as an explicit gap before extraction", async () => {
    for (const charset of ["x-synthetic-unknown", "iso-2022-kr"]) {
      serve({ "content-type": `text/html; charset=${charset}` }, "<p>text</p>");
      expect(await captureLink(base, open), charset).toMatchObject({
        ok: false,
        reason: "unsupported_charset",
        httpStatus: 200,
      });
    }
  });

  it("reports a compressed representation as an explicit gap, never captured text", async () => {
    const text = "A synthetic article with meaningful text repeated. ".repeat(20);
    serve({ "content-type": "text/plain", "content-encoding": "gzip" }, gzipSync(text));
    expect(await captureLink(base, open)).toMatchObject({
      ok: false,
      reason: "unsupported_content_encoding",
    });
    serve({ "content-type": "text/plain", "content-encoding": "identity" }, text);
    expect(await captureLink(base, open)).toMatchObject({ ok: true, text: text.trim() });
  });
});

describe("captureLink HTML extraction bounds", () => {
  it("captures text and metadata from deeply nested markup within the byte limit", async () => {
    const depth = 6000;
    serve(
      { "content-type": "text/html" },
      `<title>T</title>${"<div>".repeat(depth)}article${"</div>".repeat(depth)}`,
    );
    expect(await captureLink(base, open)).toMatchObject({ ok: true, title: "T", text: "article" });
  });

  it("ends extraction at the overall deadline as a gap while the event loop keeps running", async () => {
    serve({ "content-type": "text/html" }, adversarial);
    let ticks = 0;
    const heartbeat = setInterval(() => ticks++, 20);
    const started = performance.now();
    const r = await captureLink(base, { ...open, timeoutMs: 1500 });
    const elapsed = performance.now() - started;
    clearInterval(heartbeat);
    expect(r).toMatchObject({
      ok: false,
      reason: "timeout",
      detail: expect.stringContaining("extraction") as unknown,
      httpStatus: 200,
      chain: [`${base}/`],
    });
    expect(elapsed).toBeLessThan(1500 + 1500);
    expect(ticks).toBeGreaterThan(20);
  }, 120_000);

  it("runs a bounded number of extraction workers and rejects overflow as a capacity gap", async () => {
    serve({ "content-type": "text/html" }, adversarial);
    const pool = new ExtractionPool({ maxWorkers: 1, maxQueued: 1 });
    const options = { ...open, timeoutMs: 1500, extractionPool: pool };
    let peak = 0;
    const watch = setInterval(() => (peak = Math.max(peak, pool.running)), 5);
    const results = await Promise.all([1, 2, 3].map(() => captureLink(base, options)));
    clearInterval(watch);
    expect(results.map((r) => (r.ok ? "ok" : r.reason)).sort()).toEqual([
      "extraction_capacity",
      "timeout",
      "timeout",
    ]);
    expect(peak).toBe(1);
  }, 120_000);

  it("reports a page whose parse exceeds the worker heap limit as an extraction gap", async () => {
    serve({ "content-type": "text/html" }, "<br>".repeat(1_000_000));
    const pool = new ExtractionPool({ maxWorkers: 1, maxHeapMb: 16 });
    const options = { ...open, extractionPool: pool };
    expect(await captureLink(base, options)).toMatchObject({
      ok: false,
      reason: "extraction_limit",
      detail: expect.stringContaining("memory") as unknown,
      httpStatus: 200,
    });
    serve({ "content-type": "text/html" }, "<p>after</p>");
    expect(await captureLink(base, options)).toMatchObject({ ok: true, text: "after" });
    // A slot is released once its worker has exited, which follows the reply.
    await vi.waitFor(() => expect(pool.running).toBe(0));
  }, 60_000);

  it("reports markup whose parse work exceeds the extraction bound as an explicit gap", async () => {
    const depth = 20_000;
    serve({ "content-type": "text/html" }, `${"<div>".repeat(depth)}article`);
    expect(await captureLink(base, open)).toMatchObject({
      ok: false,
      reason: "extraction_limit",
      httpStatus: 200,
      chain: [`${base}/`],
    });
  });
});
