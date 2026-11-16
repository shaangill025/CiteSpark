import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardedFetch, isBlockedAddress, screenUrl, type GuardedFetchOptions } from "./index.ts";

describe("isBlockedAddress", () => {
  it.each([
    "0.0.0.0",
    "10.1.2.3",
    "100.64.0.1",
    "100.100.100.200",
    "127.0.0.1",
    "127.255.255.254",
    "169.254.169.254",
    "172.16.0.1",
    "172.31.255.255",
    "192.0.0.192",
    "192.168.1.1",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::",
    "::1",
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:169.254.169.254",
    "::ffff:10.0.0.1",
    "::127.0.0.1",
    "64:ff9b::7f00:1",
    "2002:7f00:1::1",
    "2002:a9fe:a9fe::",
    "fe80::1",
    "fe80::1%en0",
    "fc00::1",
    "fd00:ec2::254",
    "fec0::1",
    "ff02::1",
    "2001:db8::1",
    "2001::1",
    "0:0:0:0:0:0:0:1",
    "not-an-ip",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  it.each([
    "93.184.216.34",
    "8.8.8.8",
    "172.15.0.1",
    "172.32.0.1",
    "100.63.0.1",
    "169.253.0.1",
    "::ffff:8.8.8.8",
    "64:ff9b::808:808",
    "2606:4700:4700::1111",
    "2a00:1450:4001:81b::200e",
  ])("allows public %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });
});

describe("screenUrl", () => {
  it.each([
    ["file:///etc/passwd", "scheme"],
    ["ftp://example.com/x", "scheme"],
    ["data:text/html,hi", "scheme"],
    ["javascript:alert(1)", "scheme"],
    ["http://user:pw@example.com/", "credentials"],
    ["http://localhost/", "host"],
    ["http://app.localhost/", "host"],
    ["not a url", "invalid"],
  ])("rejects %s", (url, reason) => {
    expect(screenUrl(url)).toEqual({ ok: false, reason });
  });

  it("normalizes numeric IPv4 spellings so the address guard sees them", () => {
    const r = screenUrl("http://2130706433/");
    expect(r.ok && r.url.hostname).toBe("127.0.0.1");
    const hex = screenUrl("http://0x7f.1/");
    expect(hex.ok && hex.url.hostname).toBe("127.0.0.1");
  });
});

const HTML = "<html><head><title>T</title></head><body><p>hello</p></body></html>";

let server: Server;
let base: string;
let hits: { url: string; host: string | undefined }[];
let handler: (url: string, res: import("node:http").ServerResponse) => void;

const loopbackOnly = (ip: string) => ip === "127.0.0.1";

beforeEach(async () => {
  hits = [];
  handler = (_u, res) => res.writeHead(200, { "content-type": "text/html" }).end(HTML);
  server = createServer((req, res) => {
    hits.push({ url: req.url ?? "", host: req.headers.host });
    handler(req.url ?? "", res);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(() => {
  server.closeAllConnections();
  server.close();
});

const open = (extra: GuardedFetchOptions = {}): GuardedFetchOptions => ({
  allowAddress: loopbackOnly,
  ...extra,
});

describe("guardedFetch", () => {
  it("blocks loopback by default without connecting", async () => {
    const r = await guardedFetch(`${base}/`);
    expect(r).toMatchObject({ ok: false, reason: "blocked_target" });
    expect(hits).toHaveLength(0);
  });

  it("blocks hostnames that resolve to private or mapped addresses without connecting", async () => {
    for (const ip of ["10.0.0.5", "::ffff:127.0.0.1", "169.254.169.254", "fd00::1"]) {
      const port = new URL(base).port;
      const r = await guardedFetch(`http://internal.test:${port}/`, {
        resolve: async () => [ip],
      });
      expect(r).toMatchObject({ ok: false, reason: "blocked_target" });
    }
    expect(hits).toHaveLength(0);
  });

  it("rejects a mixed answer set containing any blocked address", async () => {
    const r = await guardedFetch("http://mixed.test/", {
      resolve: async () => ["93.184.216.34", "10.0.0.1"],
    });
    expect(r).toMatchObject({ ok: false, reason: "blocked_target" });
  });

  it("blocks file: and IP-literal targets", async () => {
    expect(await guardedFetch("file:///etc/passwd")).toMatchObject({
      ok: false,
      reason: "blocked_target",
    });
    expect(await guardedFetch("http://[::1]:1/")).toMatchObject({ reason: "blocked_target" });
    expect(await guardedFetch("http://[::ffff:127.0.0.1]:1/")).toMatchObject({
      reason: "blocked_target",
    });
    expect(await guardedFetch("http://169.254.169.254/latest/meta-data/")).toMatchObject({
      reason: "blocked_target",
    });
  });

  it("fetches a page, resolving DNS once and connecting to the validated IP", async () => {
    let calls = 0;
    const port = new URL(base).port;
    const r = await guardedFetch(
      `http://rebind.test:${port}/p`,
      open({
        // A rebinding resolver: second lookup would point at a private address.
        resolve: async () => (++calls === 1 ? ["127.0.0.1"] : ["10.0.0.1"]),
      }),
    );
    expect(r.ok).toBe(true);
    expect(calls).toBe(1);
    expect(hits).toEqual([{ url: "/p", host: `rebind.test:${port}` }]);
  });

  it("re-validates each redirect hop", async () => {
    const targets = [
      "http://169.254.169.254/latest/",
      "file:///etc/passwd",
      "http://10.0.0.1/",
      "http://[::ffff:7f00:1]/",
      "http://localhost/",
    ];
    for (const t of targets) {
      hits = [];
      handler = (_u, res) => res.writeHead(302, { location: t }).end();
      const r = await guardedFetch(`${base}/start`, open());
      expect(r, t).toMatchObject({ ok: false, reason: "blocked_target" });
      expect(r.ok ? [] : r.chain[0]).toBe(`${base}/start`);
      expect(hits).toHaveLength(1);
    }
  });

  it("blocks a redirect to a hostname whose DNS answer changed to a private address", async () => {
    handler = (_u, res) => res.writeHead(301, { location: "http://later.test/x" }).end();
    const r = await guardedFetch(`${base}/`, open({ resolve: async () => ["192.168.1.10"] }));
    expect(r).toMatchObject({ ok: false, reason: "blocked_target" });
    expect(hits).toHaveLength(1);
  });

  it("follows safe redirects, resolving relative locations, and records the chain", async () => {
    handler = (u, res) =>
      u === "/a"
        ? res.writeHead(302, { location: "/b" }).end()
        : res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(HTML);
    const r = await guardedFetch(`${base}/a`, open());
    expect(r).toMatchObject({ ok: true, finalUrl: `${base}/b`, chain: [`${base}/a`, `${base}/b`] });
  });

  it("stops redirect loops at the limit", async () => {
    handler = (_u, res) => res.writeHead(302, { location: "/again" }).end();
    const r = await guardedFetch(`${base}/`, open({ maxRedirects: 3 }));
    expect(r).toMatchObject({ ok: false, reason: "redirect_limit" });
    expect(hits).toHaveLength(4);
  });

  it("enforces the size limit on declared and undeclared bodies", async () => {
    handler = (_u, res) =>
      res.writeHead(200, { "content-type": "text/html", "content-length": "5000" }).end("x");
    expect(await guardedFetch(`${base}/`, open({ maxBytes: 1000 }))).toMatchObject({
      reason: "too_large",
    });
    handler = (_u, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("a".repeat(600));
      res.end("b".repeat(600));
    };
    expect(await guardedFetch(`${base}/`, open({ maxBytes: 1000 }))).toMatchObject({
      reason: "too_large",
    });
  });

  it("enforces content-type and the overall timeout", async () => {
    handler = (_u, res) => res.writeHead(200, { "content-type": "application/pdf" }).end("%PDF");
    expect(await guardedFetch(`${base}/`, open())).toMatchObject({
      reason: "unsupported_content_type",
    });
    handler = (_u, res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.write("<p>slow");
    };
    const t0 = Date.now();
    expect(await guardedFetch(`${base}/`, open({ timeoutMs: 150 }))).toMatchObject({
      reason: "timeout",
    });
    expect(Date.now() - t0).toBeLessThan(2000);
  });

  it("reports restricted, missing and failing pages as explicit gaps", async () => {
    for (const [status, reason] of [
      [403, "restricted"],
      [402, "restricted"],
      [404, "not_found"],
      [500, "http_error"],
    ] as const) {
      handler = (_u, res) => res.writeHead(status).end();
      expect(await guardedFetch(`${base}/`, open())).toMatchObject({
        ok: false,
        reason,
        httpStatus: status,
      });
    }
  });

  it("reports DNS failure and refused connections without throwing", async () => {
    expect(
      await guardedFetch("http://nx.test/", {
        resolve: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).toMatchObject({ reason: "dns_failure" });
    server.close();
    server.closeAllConnections();
    expect(await guardedFetch(`${base}/`, open())).toMatchObject({ reason: "network_error" });
  });
});
