// Static policy checks over the built MV3 extension (M1-08): minimal permissions, strict CSP, no remote
// code, no credential access, read-only X. Runs against `apps/extension/dist` produced by `pnpm build`.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { EXTENSION_ID, extensionIdFromKey } from "../src/identity.ts";

const root = join(import.meta.dirname, "..");
const flavors = ["dist", "dist-test"] as const;
const manifest = (dir: string) =>
  JSON.parse(readFileSync(join(root, dir, "manifest.json"), "utf8")) as Record<string, unknown>;
const scripts = (dir: string) =>
  readdirSync(join(root, dir))
    .filter((f) => f.endsWith(".js") || f.endsWith(".html"))
    .map((f) => ({ f, src: readFileSync(join(root, dir, f), "utf8") }));

describe.each(flavors)("built extension %s", (dir) => {
  const m = manifest(dir);

  test("is MV3 with only the nativeMessaging permission", () => {
    expect(m["manifest_version"]).toBe(3);
    expect(m["permissions"]).toEqual(["nativeMessaging"]);
    expect(m["host_permissions"]).toBeUndefined();
    expect(m["optional_permissions"]).toBeUndefined();
    expect(m["optional_host_permissions"]).toBeUndefined();
    expect(m["web_accessible_resources"]).toBeUndefined();
    expect(m["externally_connectable"]).toBeUndefined();
  });

  test("injects only into https://x.com pages", () => {
    const cs = m["content_scripts"] as { matches: string[]; world?: string }[];
    expect(cs.flatMap((c) => c.matches)).toEqual(["https://x.com/*", "https://x.com/*"]);
    expect(cs.map((c) => c.world ?? "ISOLATED")).toEqual(["MAIN", "ISOLATED"]);
  });

  test("never compiles WebAssembly, which the strict CSP blocks (the service worker would fail to load)", () => {
    // sha512-wasm, blake2b-wasm, xsalsa20, siphash24... compile WASM at module load; under
    // `script-src 'self'` that throws, the worker module dies before registering listeners, and the
    // popup stays on "checking". The build defines WebAssembly away so they take their JS paths.
    const csp = (m["content_security_policy"] as { extension_pages: string }).extension_pages;
    expect(csp).not.toMatch(/wasm-unsafe-eval|unsafe-eval/);
    for (const { f, src } of scripts(dir))
      expect(src, f).not.toMatch(/\bWebAssembly\s*\.|typeof WebAssembly/);
  });

  test("has a strict CSP with no remote, eval or network sources", () => {
    const csp = (m["content_security_policy"] as { extension_pages: string }).extension_pages;
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("connect-src 'none'");
    expect(csp).not.toMatch(/unsafe|https?:|\*/);
  });

  test("pins the extension ID used by the native host allowlist", () => {
    expect(extensionIdFromKey(m["key"] as string)).toBe(EXTENSION_ID);
  });

  test("bundles contain no remote code, eval, or credential access", () => {
    for (const { f, src } of scripts(dir)) {
      expect(src, f).not.toMatch(/\beval\(|new Function\(/);
      expect(src, f).not.toMatch(/document\.cookie|chrome\.cookies|getAllResponseHeaders/);
      expect(src, f).not.toMatch(/setRequestHeader|declarativeNetRequest|webRequest/);
      expect(src, f).not.toMatch(/\bimportScripts\(|<script[^>]+src=["']https?:/);
      // The only other URL literals are zod's JSON Schema `$schema` identifiers and its URL-format
      // check; none is fetched, and the CSP's connect-src 'none' would block it anyway.
      const urls = [...src.matchAll(/["'`](https?:\/\/[^"'`\s]*)/gi)]
        .map((m) => m[1]!)
        .filter((u) => !u.startsWith("https://x.com/"));
      for (const u of urls) {
        expect(u, f).toMatch(
          /^(https?:\/\/json-schema\.org\/draft[-/][0-9-]+\/schema#?|http:\/\/\[\$\{value\}\])$/,
        );
      }
    }
  });
});

test("only the pacing differs between the shipped and the test build", () => {
  const a = manifest("dist");
  const b = manifest("dist-test");
  expect(b).toEqual(a);
});
