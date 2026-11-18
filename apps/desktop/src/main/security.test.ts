import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  APP_ENTRY_URL,
  APP_ORIGIN,
  CONTENT_SECURITY_POLICY,
  isAllowedRequestUrl,
  isTrustedSender,
  resolveAppAsset,
} from "./security.ts";

describe("isTrustedSender", () => {
  const top = { url: APP_ENTRY_URL, parent: null, top: null as unknown };
  top.top = top;

  it("accepts only the app's own top-level frame", () => {
    expect(isTrustedSender(top)).toBe(true);
    expect(isTrustedSender({ url: `${APP_ORIGIN}/index.html#x`, parent: null, top: null })).toBe(
      true,
    );
  });

  it("rejects missing, remote, file and look-alike origins", () => {
    for (const url of [
      "https://example.com/",
      "file:///Users/x/index.html",
      "citspark://app.evil/index.html",
      "citspark://evil/index.html",
      "data:text/html,hi",
      "about:blank",
      "",
    ]) {
      expect(isTrustedSender({ url, parent: null, top: null }), url).toBe(false);
    }
    expect(isTrustedSender(null)).toBe(false);
    expect(isTrustedSender(undefined)).toBe(false);
  });

  it("rejects subframes even from the app origin", () => {
    expect(isTrustedSender({ url: APP_ENTRY_URL, parent: top, top })).toBe(false);
  });
});

describe("isAllowedRequestUrl", () => {
  it("allows only app-scheme and devtools requests", () => {
    expect(isAllowedRequestUrl(`${APP_ORIGIN}/renderer.js`)).toBe(true);
    for (const url of [
      "https://example.com/x.js",
      "http://127.0.0.1:9/",
      "ws://localhost/",
      "file:///etc/passwd",
      "citspark://other/x",
      "ftp://x/",
    ]) {
      expect(isAllowedRequestUrl(url), url).toBe(false);
    }
  });
});

describe("CONTENT_SECURITY_POLICY", () => {
  it("allows no remote, inline or eval script and no network connections", () => {
    const d = Object.fromEntries(
      CONTENT_SECURITY_POLICY.split(";").map((p) => {
        const [k, ...v] = p.trim().split(/\s+/);
        return [k, v.join(" ")];
      }),
    );
    expect(d["default-src"]).toBe("'none'");
    expect(d["script-src"]).toBe("'self'");
    expect(d["connect-src"]).toBe("'none'");
    expect(d["object-src"]).toBe("'none'");
    expect(d["frame-src"]).toBe("'none'");
    expect(d["base-uri"]).toBe("'none'");
    expect(d["form-action"]).toBe("'none'");
    expect(CONTENT_SECURITY_POLICY).not.toMatch(/unsafe-(inline|eval)|https?:|\*/);
  });
});

describe("resolveAppAsset", () => {
  let root: string;
  let outside: string;
  beforeAll(() => {
    const base = mkdtempSync(join(tmpdir(), "citspark-assets-"));
    root = join(base, "renderer");
    outside = join(base, "secret.txt");
    mkdirSync(join(root, "assets"), { recursive: true });
    writeFileSync(join(root, "index.html"), "<!doctype html>");
    writeFileSync(join(root, "assets", "app.js"), "1");
    writeFileSync(outside, "secret");
    symlinkSync(outside, join(root, "link.txt"));
  });
  afterAll(() => rmSync(join(root, ".."), { recursive: true, force: true }));

  it("maps app URLs to files under the renderer root", () => {
    expect(resolveAppAsset(root, `${APP_ORIGIN}/`)).toMatchObject({
      file: join(root, "index.html"),
    });
    expect(resolveAppAsset(root, `${APP_ORIGIN}/assets/app.js`)).toMatchObject({
      file: join(root, "assets", "app.js"),
      mimeType: "text/javascript",
    });
  });

  it("refuses traversal, other hosts, symlinks out and missing files", () => {
    for (const url of [
      `${APP_ORIGIN}/../secret.txt`,
      `${APP_ORIGIN}/%2e%2e/secret.txt`,
      `${APP_ORIGIN}/assets/%2e%2e%2f..%2fsecret.txt`,
      `${APP_ORIGIN}/link.txt`,
      `${APP_ORIGIN}/missing.js`,
      "citspark://evil/index.html",
      `${APP_ORIGIN}/assets/`,
      "not a url",
    ]) {
      expect(resolveAppAsset(root, url), url).toBeUndefined();
    }
  });
});
