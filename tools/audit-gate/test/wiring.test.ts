// Checks that CI runs the gate in place of the old audit step and that the committed policy is exactly the
// owner-approved exception (GHSA-fc5q-39xc-vjpf, issue #21).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { parsePolicy } from "../src/policy.ts";

const REPO = join(import.meta.dirname, "..", "..", "..");
const read = (path: string) => readFileSync(join(REPO, path), "utf8");

test("CI's ubuntu Dependency audit step runs the gate and nothing weaker", () => {
  const ci = read(".github/workflows/ci.yml");
  expect(ci).toContain(
    "      - name: Dependency audit\n        if: matrix.os == 'ubuntu-latest'\n        run: pnpm audit-gate\n",
  );
  expect(ci).not.toMatch(/pnpm audit(?!-gate\n)/);
  expect(ci).not.toMatch(/ignore-unfixable|ignore-registry-errors|--audit-level/);
  const manifest = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
  expect(manifest.scripts["audit-gate"]).toBe(
    "node --experimental-strip-types --no-warnings tools/audit-gate/cli.ts",
  );
  for (const file of ["package.json", "pnpm-workspace.yaml", ".npmrc"]) {
    let text = "";
    try {
      text = read(file);
    } catch {
      continue;
    }
    expect(text).not.toMatch(/auditConfig|ignoreGhsas|ignoreCves|ignore-registry-errors/i);
  }
});

test("the committed policy is exactly the owner-approved 14-day exception tracked in issue 21", () => {
  const raw = JSON.parse(read("tools/audit-gate/audit-exceptions.json")) as unknown;
  const parsed = parsePolicy(raw, new Date("2026-11-18T03:27:59Z"));
  expect(parsed.errors).toEqual([]);
  expect(parsed.exceptions).toHaveLength(1);
  const { rationale, ...rest } = parsed.exceptions[0]!;
  expect(rest).toEqual({
    advisory: "GHSA-fc5q-39xc-vjpf",
    cve: "CVE-2026-112366",
    module: "picomatch",
    severity: "high",
    scope: "development",
    findings: [
      {
        version: "2.3.2",
        path: ".>typescript-eslint>@typescript-eslint/typescript-estree>fast-glob>micromatch>picomatch",
      },
      { version: "4.0.7", path: ".>vitest>picomatch" },
    ],
    owner: "shaangill025",
    createdAt: "2026-11-18T03:27:59Z",
    expiresAt: "2026-12-02T03:27:59Z",
    tracking: "https://github.com/shaangill025/CiteSpark/issues/21",
  });
  expect(rationale).toMatch(/not fixed/);
});
