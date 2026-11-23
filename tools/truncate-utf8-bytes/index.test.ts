import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

// electron-builder's sanitize-filename loads this package with require(); test the CommonJS entry it gets.
const truncate = createRequire(import.meta.url)("./index.cjs") as (s: string, n: number) => string;

describe("truncate-utf8-bytes replacement", () => {
  it("keeps strings that already fit", () => {
    expect(truncate("abc", 3)).toBe("abc");
    expect(truncate("abc", 10)).toBe("abc");
    expect(truncate("", 0)).toBe("");
  });

  it("cuts ASCII at the byte limit", () => {
    expect(truncate("abcdef", 4)).toBe("abcd");
    expect(truncate("abc", 0)).toBe("");
  });

  it("never splits a multi-byte character", () => {
    // "é" is 2 bytes, "€" is 3 bytes in UTF-8.
    expect(truncate("aé", 2)).toBe("a");
    expect(truncate("aé", 3)).toBe("aé");
    expect(truncate("€€", 5)).toBe("€");
    expect(Buffer.byteLength(truncate("x€€€", 7))).toBeLessThanOrEqual(7);
  });

  it("never splits a surrogate pair", () => {
    const emoji = "\u{1F600}"; // 4 bytes, two UTF-16 code units
    expect(truncate(`a${emoji}`, 4)).toBe("a");
    expect(truncate(`a${emoji}`, 5)).toBe(`a${emoji}`);
  });

  it("counts a lone surrogate as the 3-byte replacement character Node writes", () => {
    expect(truncate("a\uD800b", 4)).toBe("a\uD800");
    expect(truncate("a\uD800b", 3)).toBe("a");
  });

  it("rejects non-strings like the package it replaces", () => {
    expect(() => truncate(42 as unknown as string, 3)).toThrow("Input must be string");
  });
});
