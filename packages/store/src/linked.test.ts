import Database from "better-sqlite3";
import { captureLink, ExtractionPool } from "../../core/src/index.ts";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LinkedSourceStore, migrate, type LinkCapture } from "./index.ts";

let db: Database.Database;
let server: Server;
let base: string;
let hits: string[];
let pages: Record<
  string,
  { status?: number; type?: string; body: string | Buffer; location?: string; encoding?: string }
>;

const capture = (url: string): Promise<LinkCapture> =>
  captureLink(url, { allowAddress: (ip) => ip === "127.0.0.1" });

const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

beforeEach(async () => {
  hits = [];
  pages = {};
  db = new Database(":memory:");
  migrate(db);
  db.prepare(
    "INSERT INTO source (id, source_type) VALUES ('p1', 'x_post'), ('p2', 'x_post')",
  ).run();
  server = createServer((req, res) => {
    hits.push(req.url ?? "");
    const p = pages[req.url ?? ""];
    if (!p) return void res.writeHead(404).end();
    const h: Record<string, string> = { "content-type": p.type ?? "text/html" };
    if (p.location) h.location = p.location;
    if (p.encoding) h["content-encoding"] = p.encoding;
    res.writeHead(p.status ?? 200, h).end(p.body);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  server.closeAllConnections();
  server.close();
  db.close();
});

describe("LinkedSourceStore", () => {
  it("captures a linked article with provenance and a relationship", async () => {
    pages["/a"] = {
      body: `<title>Art</title><link rel="canonical" href="${base}/canon"><p>Body text <a href="${base}/b">more</a></p>`,
    };
    const store = new LinkedSourceStore(db, capture);
    const [o] = await store.enrich("p1", [{ url: `${base}/a`, kind: "web" }]);
    expect(o).toMatchObject({ status: "captured", gapReason: null });
    const src = db.prepare("SELECT * FROM source WHERE id = ?").get(o?.sourceId) as {
      source_type: string;
      canonical_url: string;
    };
    expect(src).toMatchObject({ source_type: "article", canonical_url: `${base}/canon` });
    const f = db.prepare("SELECT * FROM linked_fetch").get() as Record<string, unknown>;
    expect(f).toMatchObject({
      original_url: `${base}/a`,
      final_url: `${base}/a`,
      canonical_url: `${base}/canon`,
      title: "Art",
      extraction_method: "html-dom-v1",
      gap_reason: null,
    });
    expect(f.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(f.observed_at).toBeTruthy();
    expect(
      db.prepare("SELECT text FROM source_version WHERE source_id = ?").get(o?.sourceId),
    ).toEqual({ text: "Body text more" });
    expect(
      count("SELECT COUNT(*) n FROM relationship WHERE type = 'links_to' AND origin = 'captured'"),
    ).toBe(1);
  });

  it("does not crawl links found inside fetched pages", async () => {
    pages["/a"] = { body: `<p><a href="${base}/b">b</a> ${base}/c</p>` };
    pages["/b"] = { body: "<p>b</p>" };
    await new LinkedSourceStore(db, capture).enrich("p1", [{ url: `${base}/a`, kind: "web" }]);
    expect(hits).toEqual(["/a"]);
  });

  it("reuses saved sources and deduplicates destinations across parents", async () => {
    db.prepare(
      "INSERT INTO source (id, source_type, canonical_url) VALUES ('art', 'article', ?)",
    ).run(`${base}/saved`);
    db.prepare(
      "INSERT INTO source (id, source_type, platform_id) VALUES ('x:99', 'x_post', '99')",
    ).run();
    pages["/a"] = { body: "<p>shared</p>" };
    const store = new LinkedSourceStore(db, capture);
    const links = [
      { url: `${base}/saved`, kind: "web" as const },
      { url: "https://x.com/u/status/99", kind: "x_post" as const, platformId: "99" },
      { url: `${base}/a`, kind: "web" as const },
    ];
    const first = await store.enrich("p1", links);
    expect(first.map((o) => o.status)).toEqual(["reused", "reused", "captured"]);
    expect(first.map((o) => o.sourceId).slice(0, 2)).toEqual(["art", "x:99"]);
    const second = await store.enrich("p2", links);
    expect(second.map((o) => o.status)).toEqual(["reused", "reused", "reused"]);
    expect(hits).toEqual(["/a"]);
    expect(count("SELECT COUNT(*) n FROM source WHERE source_type = 'article'")).toBe(2);
    expect(count("SELECT COUNT(*) n FROM relationship")).toBe(6);
    await store.enrich("p1", links);
    expect(count("SELECT COUNT(*) n FROM relationship")).toBe(6);
  });

  it("reuses an existing source when a redirect lands on its canonical URL", async () => {
    db.prepare(
      "INSERT INTO source (id, source_type, canonical_url) VALUES ('art', 'article', ?)",
    ).run(`${base}/final`);
    pages["/short"] = { status: 301, body: "", location: "/final" };
    pages["/final"] = { body: "<p>x</p>" };
    const [o] = await new LinkedSourceStore(db, capture).enrich("p1", [
      { url: `${base}/short`, kind: "web" },
    ]);
    expect(o).toMatchObject({ status: "reused", sourceId: "art" });
    expect(count("SELECT COUNT(*) n FROM source WHERE source_type = 'article'")).toBe(1);
  });

  it("stores the fetched snapshot when a short URL redirects to an existing changed article", async () => {
    db.prepare(
      "INSERT INTO source (id, source_type, canonical_url) VALUES ('art', 'article', ?)",
    ).run(`${base}/final`);
    db.prepare(
      "INSERT INTO source_version (source_id, content_hash, text) VALUES ('art', 'old-hash', 'old text')",
    ).run();
    pages["/short"] = { status: 301, body: "", location: "/final" };
    pages["/final"] = { body: "<title>New</title><p>revised text</p>" };
    const store = new LinkedSourceStore(db, capture);
    const [o] = await store.enrich("p1", [{ url: `${base}/short`, kind: "web" }]);
    expect(o).toMatchObject({ status: "reused", sourceId: "art" });
    const f = db
      .prepare("SELECT source_id, content_hash, title FROM linked_fetch WHERE original_url = ?")
      .get(`${base}/short`) as { source_id: string; content_hash: string; title: string };
    expect(f).toMatchObject({ source_id: "art", title: "New" });
    // The recorded capture has a matching immutable snapshot and an observation of it.
    const v = db
      .prepare("SELECT id, text FROM source_version WHERE source_id = 'art' AND content_hash = ?")
      .get(f.content_hash) as { id: number; text: string } | undefined;
    expect(v?.text).toBe("revised text");
    expect(
      db
        .prepare(
          "SELECT text FROM source_version WHERE source_id = 'art' AND content_hash = 'old-hash'",
        )
        .get(),
    ).toEqual({ text: "old text" });
    const obs = db
      .prepare(
        "SELECT method, evidence FROM observation WHERE source_id = 'art' AND version_id = ?",
      )
      .all(v?.id) as { method: string; evidence: string }[];
    expect(obs).toHaveLength(1);
    expect(obs[0]?.method).toBe("html-dom-v1");
    expect(JSON.parse(obs[0]?.evidence ?? "{}")).toMatchObject({
      originalUrl: `${base}/short`,
      finalUrl: `${base}/final`,
      chain: [`${base}/short`, `${base}/final`],
    });

    // A second short link to unchanged content reuses the snapshot and adds only an observation.
    pages["/short2"] = { status: 302, body: "", location: "/final" };
    await store.enrich("p2", [{ url: `${base}/short2`, kind: "web" }]);
    expect(count("SELECT COUNT(*) n FROM source_version WHERE source_id = 'art'")).toBe(2);
    expect(
      count(`SELECT COUNT(*) n FROM observation WHERE source_id = 'art' AND version_id = ${v?.id}`),
    ).toBe(2);
    // Every captured provenance row joins to a stored snapshot of its source.
    expect(
      count(`SELECT COUNT(*) n FROM linked_fetch f WHERE f.source_id IS NOT NULL AND f.content_hash IS NOT NULL
               AND NOT EXISTS (SELECT 1 FROM source_version v WHERE v.source_id = f.source_id AND v.content_hash = f.content_hash)`),
    ).toBe(0);
  });

  it("fetches a destination once when overlapping enrich calls race", async () => {
    pages["/a"] = { body: "<p>shared</p>" };
    pages["/gone"] = { status: 403, body: "" };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const gated = async (url: string): Promise<LinkCapture> => {
      await gate;
      return capture(url);
    };
    const a = new LinkedSourceStore(db, gated);
    const b = new LinkedSourceStore(db, gated); // a second store on the same connection
    const links = [
      { url: `${base}/a`, kind: "web" as const },
      { url: `${base}/gone`, kind: "web" as const },
    ];
    const pending = Promise.all([
      a.enrich("p1", links),
      a.enrich("p2", links),
      b.enrich("p2", links),
    ]);
    release();
    const [one, two, three] = await pending;
    expect(hits.sort()).toEqual(["/a", "/gone"]);
    expect(one?.[0]?.sourceId).toBeTruthy();
    expect(two?.[0]?.sourceId).toBe(one?.[0]?.sourceId);
    expect(three?.[0]?.sourceId).toBe(one?.[0]?.sourceId);
    expect([one, two, three].map((o) => o?.[1]?.gapReason)).toEqual([
      "restricted",
      "restricted",
      "restricted",
    ]);
    expect(count("SELECT COUNT(*) n FROM source WHERE source_type = 'article'")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM source_version")).toBe(1);
    expect(count("SELECT COUNT(*) n FROM relationship WHERE type = 'links_to'")).toBe(2);
    expect(a.gaps("p1")).toHaveLength(1);
    expect(a.gaps("p2")).toHaveLength(1);
  });

  it("ignores a cross-host canonical claim", async () => {
    pages["/a"] = { body: '<link rel="canonical" href="https://victim.example/page"><p>x</p>' };
    const [o] = await new LinkedSourceStore(db, capture).enrich("p1", [
      { url: `${base}/a`, kind: "web" },
    ]);
    expect(db.prepare("SELECT canonical_url FROM source WHERE id = ?").get(o?.sourceId)).toEqual({
      canonical_url: `${base}/a`,
    });
  });

  it("attaches metadata-faked and unquoted-canonical pages to the real source only", async () => {
    db.prepare(
      "INSERT INTO source (id, source_type, canonical_url) VALUES ('real', 'article', ?), ('wrong', 'article', ?)",
    ).run(`${base}/real`, `${base}/wrong`);
    pages["/script"] = {
      body:
        '<head><script>const sample=`<meta property="og:title" content="Fake"><link rel="canonical" href="/wrong">`;</script>' +
        '<title>Real</title><link rel="canonical" href="/real"></head><p>Real article</p>',
    };
    pages["/unquoted"] = {
      body: "<title>Real</title><link rel=canonical href=/real><p>Real article</p>",
    };
    const store = new LinkedSourceStore(db, capture);
    const out = await store.enrich("p1", [
      { url: `${base}/script`, kind: "web" },
      { url: `${base}/unquoted`, kind: "web" },
    ]);
    expect(out.map((o) => [o.status, o.sourceId])).toEqual([
      ["reused", "real"],
      ["reused", "real"],
    ]);
    expect(
      db.prepare("SELECT title, canonical_url, source_id FROM linked_fetch ORDER BY id").all(),
    ).toEqual([
      { title: "Real", canonical_url: `${base}/real`, source_id: "real" },
      { title: "Real", canonical_url: `${base}/real`, source_id: "real" },
    ]);
    expect(count("SELECT COUNT(*) n FROM source_version WHERE source_id = 'wrong'")).toBe(0);
    expect(count("SELECT COUNT(*) n FROM observation WHERE source_id = 'wrong'")).toBe(0);
    expect(count("SELECT COUNT(*) n FROM source WHERE source_type = 'article'")).toBe(2);
    expect(db.prepare("SELECT text FROM source_version WHERE source_id = 'real'").all()).toEqual([
      { text: "Real article" },
    ]);
  });

  it("stores decoded declared-charset text and keeps undecodable or compressed bodies as gaps", async () => {
    pages["/latin1"] = {
      type: "text/html; charset=iso-8859-1",
      body: Buffer.from("<title>Caf\xe9</title><p>Caf\xe9</p>", "latin1"),
    };
    pages["/bad"] = {
      type: "text/html; charset=utf-8",
      body: Buffer.from([0x3c, 0x70, 0x3e, 0xe9]),
    };
    pages["/gzip"] = { type: "text/plain", encoding: "gzip", body: gzipSync("compressed text") };
    const out = await new LinkedSourceStore(db, capture).enrich("p1", [
      { url: `${base}/latin1`, kind: "web" },
      { url: `${base}/bad`, kind: "web" },
      { url: `${base}/gzip`, kind: "web" },
    ]);
    expect(out.map((o) => o.gapReason)).toEqual([
      null,
      "invalid_text_encoding",
      "unsupported_content_encoding",
    ]);
    expect(db.prepare("SELECT title FROM linked_fetch WHERE source_id IS NOT NULL").all()).toEqual([
      { title: "Café" },
    ]);
    expect(db.prepare("SELECT text FROM source_version").all()).toEqual([{ text: "Café" }]);
  });

  it("captures deeply nested markup and keeps over-bound markup as a persistent gap", async () => {
    pages["/deep"] = {
      body: `<title>T</title>${"<div>".repeat(6000)}article${"</div>".repeat(6000)}`,
    };
    pages["/deeper"] = { body: `${"<div>".repeat(20_000)}article` };
    const store = new LinkedSourceStore(db, capture);
    const links = [
      { url: `${base}/deep`, kind: "web" as const },
      { url: `${base}/deeper`, kind: "web" as const },
    ];
    const out = await store.enrich("p1", links);
    expect(out.map((o) => [o.status, o.gapReason])).toEqual([
      ["captured", null],
      ["gap", "extraction_limit"],
    ]);
    expect(db.prepare("SELECT text FROM source_version").all()).toEqual([{ text: "article" }]);
    expect(
      db
        .prepare(
          "SELECT source_id, gap_reason, http_status FROM linked_fetch WHERE original_url = ?",
        )
        .get(`${base}/deeper`),
    ).toEqual({ source_id: null, gap_reason: "extraction_limit", http_status: 200 });
    expect(store.gaps("p1").map((g) => g.reason)).toEqual(["extraction_limit"]);
    const again = await store.enrich("p2", links);
    expect(again.map((o) => o.status)).toEqual(["reused", "known_gap"]);
    expect(hits).toEqual(["/deep", "/deeper"]);
    expect(count("SELECT COUNT(*) n FROM source_version")).toBe(1);
  });

  it("records explicit gaps once and keeps them visible", async () => {
    pages["/paywall"] = { status: 403, body: "" };
    pages["/pdf"] = { type: "application/pdf", body: "%PDF" };
    pages["/empty"] = { body: "<script>x</script>" };
    const store = new LinkedSourceStore(db, capture);
    const links = [
      { url: `${base}/paywall`, kind: "web" as const },
      { url: `${base}/pdf`, kind: "web" as const },
      { url: `${base}/empty`, kind: "web" as const },
      { url: "http://10.0.0.5/admin", kind: "web" as const },
      { url: "file:///etc/passwd", kind: "web" as const },
      { url: "https://x.com/u/status/7", kind: "x_post" as const, platformId: "7" },
    ];
    const out = await store.enrich("p1", links);
    expect(out.map((o) => o.gapReason)).toEqual([
      "restricted",
      "unsupported_content_type",
      "empty_content",
      "blocked_target",
      "blocked_target",
      "x_post_not_saved",
    ]);
    expect(store.gaps("p1")).toHaveLength(6);
    expect(count("SELECT COUNT(*) n FROM source WHERE source_type = 'article'")).toBe(0);
    const again = await store.enrich("p2", links);
    expect(again.every((o) => o.status === "known_gap")).toBe(true);
    expect(hits).toEqual(["/paywall", "/pdf", "/empty"]);
    expect(store.gaps("p2")).toHaveLength(6);
  });

  it("retries transient gaps only on request and resolves a saved X post later", async () => {
    const store = new LinkedSourceStore(db, capture);
    const link = { url: `${base}/late`, kind: "web" as const };
    pages["/late"] = { status: 503, body: "" };
    expect((await store.enrich("p1", [link]))[0]?.gapReason).toBe("http_error");
    pages["/late"] = { body: "<p>now ok</p>" };
    expect((await store.enrich("p1", [link]))[0]?.status).toBe("known_gap");
    expect((await store.enrich("p1", [link], { retryTransientGaps: true }))[0]?.status).toBe(
      "captured",
    );
    expect(store.gaps("p1")).toHaveLength(0);

    const x = { url: "https://x.com/u/status/55", kind: "x_post" as const, platformId: "55" };
    await store.enrich("p1", [x]);
    db.prepare(
      "INSERT INTO source (id, source_type, platform_id) VALUES ('x:55', 'x_post', '55')",
    ).run();
    expect((await store.enrich("p1", [x]))[0]).toMatchObject({
      status: "reused",
      sourceId: "x:55",
    });
    expect(store.gaps("p1")).toHaveLength(0);
  });

  it("keeps a page rejected for extraction capacity retryable and unstored", async () => {
    pages["/slow"] = {
      body: `${"<span>".repeat(6000)}${"</button>".repeat(400_000)}<article>slow</article>`,
    };
    pages["/normal"] = { body: "<p>normal page</p>" };
    const pool = new ExtractionPool({ maxWorkers: 1, maxQueued: 0 });
    const pooled = (url: string): Promise<LinkCapture> =>
      captureLink(url, {
        allowAddress: (ip) => ip === "127.0.0.1",
        timeoutMs: 1000,
        extractionPool: pool,
      });
    const store = new LinkedSourceStore(db, pooled);
    const slow = store.enrich("p1", [{ url: `${base}/slow`, kind: "web" }]);
    await vi.waitFor(() => expect(pool.running).toBe(1));
    const normal = { url: `${base}/normal`, kind: "web" as const };
    expect((await store.enrich("p2", [normal]))[0]?.gapReason).toBe("extraction_capacity");
    expect((await slow)[0]?.gapReason).toBe("timeout");
    expect(count("SELECT COUNT(*) n FROM source_version")).toBe(0);
    await vi.waitFor(() => expect(pool.running).toBe(0));
    expect((await store.enrich("p2", [normal], { retryTransientGaps: true }))[0]).toMatchObject({
      status: "captured",
      gapReason: null,
    });
    expect(db.prepare("SELECT text FROM source_version").all()).toEqual([{ text: "normal page" }]);
  }, 60_000);
});
