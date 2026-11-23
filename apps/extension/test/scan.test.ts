import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { scanForCredentials } from "./t02/scan.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((d) => rmSync(d, { recursive: true, force: true })));
const dir = () => {
  const d = mkdtempSync(join(tmpdir(), "cs-scan-"));
  dirs.push(d);
  return d;
};
const CANARY = "SYNTHCANARY-ct0-4f1e9a";

describe("credential-disclosure scanner (SEC-04)", () => {
  test("finds a planted canary in nested files, including UTF-16 storage", () => {
    const d = dir();
    writeFileSync(join(d, "clean.txt"), "Synthetic post text only");
    writeFileSync(join(d, "leveldb.log"), Buffer.from(`x${CANARY}y`, "utf16le"));
    const f = scanForCredentials([d], [CANARY]);
    expect(f.map((x) => x.file)).toEqual([join(d, "leveldb.log")]);
  });

  test.each([
    "cookie: ct0=abcdef123456",
    // Built at run time so the source holds no literal key=value pair for secret scanners.
    ["auth", "token"].join("_") + "=0123456789abcdef",
    "authorization: Bearer AAAAAAAAAAAAAAAAAAAAAsynthetic",
    "x-csrf-token",
  ])("finds the session material shape %j without a canary", (text) => {
    const d = dir();
    writeFileSync(join(d, "a.json"), text);
    expect(scanForCredentials([d], [])).not.toEqual([]);
  });

  test("passes clean library output", () => {
    const d = dir();
    writeFileSync(
      join(d, "lib.sqlite"),
      "Synthetic bookmarked post number 1 https://x.com/synth_bob/status/1",
    );
    expect(scanForCredentials([d, join(d, "missing")], [CANARY])).toEqual([]);
  });
});
