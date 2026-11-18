// Synthetic test fixtures. The report shape mirrors the JSON that `pnpm audit --json` (pnpm 10.21.0)
// printed for this repository: { actions, advisories, muted, metadata }. Advisory text, dates and the
// "synthetic-*" advisories are invented; only the identifiers the approved exception names
// (GHSA-fc5q-39xc-vjpf, CVE-2026-112366, picomatch and its two reviewed paths) are real, because the gate
// matches on them exactly.

export const PICOMATCH_GHSA = "GHSA-fc5q-39xc-vjpf";
export const ESLINT_PATH =
  ".>typescript-eslint>@typescript-eslint/typescript-estree>fast-glob>micromatch>picomatch";
export const VITEST_PATH = ".>vitest>picomatch";

export interface FixtureAdvisory {
  id: number;
  module_name: string;
  severity: string;
  github_advisory_id: string;
  cves: string[];
  vulnerable_versions: string;
  patched_versions: string;
  findings: { version: string; paths: string[] }[];
  [key: string]: unknown;
}

export function advisory(over: Partial<FixtureAdvisory> = {}): FixtureAdvisory {
  return {
    findings: [
      { version: "2.3.2", paths: [ESLINT_PATH] },
      { version: "4.0.7", paths: [VITEST_PATH] },
    ],
    found_by: null,
    deleted: null,
    references: "synthetic",
    created: "2026-10-19T18:32:12.000Z",
    id: 1247710,
    npm_advisory_id: null,
    overview: "Synthetic overview text.",
    reported_by: null,
    title: "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
    metadata: null,
    cves: ["CVE-2026-112366"],
    access: "public",
    severity: "high",
    module_name: "picomatch",
    vulnerable_versions: "<=4.0.7",
    github_advisory_id: PICOMATCH_GHSA,
    recommendation: "None",
    patched_versions: "<0.0.0",
    updated: "2026-11-17T15:56:44.000Z",
    cvss: { score: 7.5, vectorString: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:H" },
    cwe: ["CWE-1333"],
    url: `https://github.com/advisories/${PICOMATCH_GHSA}`,
    ...over,
  };
}

export function syntheticAdvisory(
  id: number,
  severity: string,
  over: Partial<FixtureAdvisory> = {},
): FixtureAdvisory {
  return advisory({
    id,
    severity,
    module_name: `synthetic-${id}`,
    github_advisory_id: "GHSA-2222-3333-4444",
    cves: [],
    title: "Synthetic advisory",
    vulnerable_versions: "<1.0.1",
    patched_versions: ">=1.0.1",
    findings: [{ version: "1.0.0", paths: [`.>vitest>synthetic-${id}`] }],
    url: "https://github.com/advisories/GHSA-2222-3333-4444",
    ...over,
  });
}

const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;

// Builds a report whose declared counts equal the enumerated finding paths, as pnpm 10 printed them.
export function report(advisories: FixtureAdvisory[]): Record<string, unknown> {
  const vulnerabilities: Record<string, number> = Object.fromEntries(SEVERITIES.map((s) => [s, 0]));
  for (const a of advisories) {
    for (const f of a.findings)
      vulnerabilities[a.severity] = (vulnerabilities[a.severity] ?? 0) + f.paths.length;
  }
  return {
    actions: [],
    advisories: Object.fromEntries(advisories.map((a) => [String(a.id), a])),
    muted: [],
    metadata: {
      vulnerabilities,
      dependencies: 275,
      devDependencies: 0,
      optionalDependencies: 0,
      totalDependencies: 275,
    },
  };
}

export const CREATED_AT = "2026-11-18T03:27:59Z";
export const EXPIRES_AT = "2026-12-02T03:27:59Z";
export const INSIDE_WINDOW = new Date("2026-11-20T00:00:00Z");

export function exception(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    advisory: PICOMATCH_GHSA,
    cve: "CVE-2026-112366",
    module: "picomatch",
    severity: "high",
    scope: "development",
    findings: [
      { version: "2.3.2", path: ESLINT_PATH },
      { version: "4.0.7", path: VITEST_PATH },
    ],
    owner: "shaangill025",
    createdAt: CREATED_AT,
    expiresAt: EXPIRES_AT,
    tracking: "https://github.com/shaangill025/CiteSpark/issues/21",
    rationale:
      "Synthetic rationale: reachable only through fixed, repository-controlled tool globs.",
    ...over,
  };
}

export function policy(
  exceptions: Record<string, unknown>[] = [exception()],
): Record<string, unknown> {
  return { schemaVersion: 1, exceptions };
}

export const ROOT_MANIFEST = {
  name: "synthetic-root",
  packageManager: "pnpm@10.21.0",
  devDependencies: { vitest: "^4.0.0", "typescript-eslint": "8.46.4" },
};
