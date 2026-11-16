import { expect, test } from "vitest";
import { findViolations, flattenPnpmLicenses, isAllowed } from "./check.ts";

test("allows permissive licenses and compound expressions", () => {
  expect(isAllowed("MIT")).toBe(true);
  expect(isAllowed("(MIT OR GPL-3.0-only)")).toBe(true);
  expect(isAllowed("MIT AND GPL-3.0-only")).toBe(false);
  expect(isAllowed("(MIT OR GPL-3.0-only) AND Apache-2.0")).toBe(true);
  expect(isAllowed("(MIT OR GPL-3.0-only) AND GPL-3.0-only")).toBe(false);
  expect(isAllowed("MIT OR GPL-3.0-only AND GPL-2.0-only")).toBe(true);
  expect(isAllowed("(MIT")).toBe(false);
});

test("fails on a planted GPL dependency", () => {
  const entries = flattenPnpmLicenses({
    MIT: [{ name: "fine", versions: ["1.0.0"], license: "MIT" }],
    "GPL-3.0-only": [{ name: "planted-gpl", versions: ["1.0.0"], license: "GPL-3.0-only" }],
    "GPL-2.0-only": ["spec-string@2.0.0"],
    Unknown: [{ name: "mystery", versions: ["0.1.0"], license: "Unknown" }],
  });
  expect(findViolations(entries).map((v) => v.name)).toEqual([
    "planted-gpl",
    "spec-string",
    "mystery",
  ]);
});

test("parses specifier strings into entries", () => {
  expect(flattenPnpmLicenses({ MIT: ["@scope/pkg@1.2.3"] })).toEqual([
    { name: "@scope/pkg", versions: ["1.2.3"], license: "MIT" },
  ]);
});
