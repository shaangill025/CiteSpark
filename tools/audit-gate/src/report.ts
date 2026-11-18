// Strict reader for the JSON that `pnpm audit --json` (pnpm 10) prints. Anything unexpected is rejected so the
// gate fails closed instead of guessing.

export interface Finding {
  version: string;
  paths: string[];
}

export interface Advisory {
  id: number;
  module_name: string;
  severity: string;
  github_advisory_id: string;
  cves: string[];
  patched_versions: string;
  vulnerable_versions: string;
  findings: Finding[];
}

export interface ParsedReport {
  advisories: Advisory[];
  // metadata.vulnerabilities as declared by the registry, per severity.
  declared: Record<(typeof SEVERITIES)[number], number>;
}

export class ReportError extends Error {}

export const SEVERITIES = ["info", "low", "moderate", "high", "critical"] as const;
const TOP_LEVEL = ["actions", "advisories", "muted", "metadata"];
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

// Stands in for pnpm output that did not parse as JSON (network errors, ignored registry errors, crashes).
export const NOT_JSON: unique symbol = Symbol("pnpm output is not JSON");

export function parseReport(raw: unknown, exitCode: number): ParsedReport {
  if (raw === NOT_JSON) throw new ReportError("pnpm output is not JSON");
  if (
    !isRecord(raw) ||
    Object.keys(raw).length !== TOP_LEVEL.length ||
    !TOP_LEVEL.every((k) => Object.hasOwn(raw, k)) ||
    !Array.isArray(raw.actions) ||
    !isRecord(raw.advisories) ||
    !Array.isArray(raw.muted) ||
    !isRecord(raw.metadata)
  ) {
    throw new ReportError("not a pnpm 10 audit report {actions, advisories, muted, metadata}");
  }
  if (raw.muted.length > 0) throw new ReportError("muted advisories are not supported");
  const advisories = Object.entries(raw.advisories).map(([key, a]) => {
    if (!isAdvisory(a) || String(a.id) !== key)
      throw new ReportError(`advisory ${key} is malformed`);
    return a;
  });
  rejectRepeats(advisories);
  const declared = checkDeclaredCounts(raw.metadata.vulnerabilities, advisories);
  const total = SEVERITIES.reduce((n, s) => n + declared[s], 0);
  // pnpm 10 with --json exits 1 exactly when any vulnerability is counted (any severity) and 0 otherwise.
  if (exitCode !== (total > 0 ? 1 : 0)) {
    throw new ReportError(
      `pnpm audit exited ${exitCode}, expected 1 when vulnerabilities are counted and 0 otherwise`,
    );
  }
  return { advisories, declared };
}

// A repeated (advisory, version, path) would let a malformed report pad the enumerated paths and so absorb the
// count of a hidden advisory. One GHSA may legitimately appear under several advisory ids (one per affected
// package), so repeats are checked per GHSA across the whole report.
function rejectRepeats(advisories: Advisory[]): void {
  const seen = new Set<string>();
  for (const a of advisories) {
    for (const f of a.findings) {
      for (const path of f.paths) {
        const item = JSON.stringify([a.github_advisory_id, f.version, path]);
        if (seen.has(item)) {
          throw new ReportError(
            `advisory ${String(a.id)} repeats ${a.github_advisory_id} ${a.module_name}@${f.version} via ${path}`,
          );
        }
        seen.add(item);
      }
    }
  }
}

// pnpm 10.21 with --json drops advisories matched by auditConfig.ignoreGhsas or ignoreCves but keeps their
// counts in metadata.vulnerabilities, so counts are the only trace of a hidden advisory. For high and critical
// the declared count must equal the number of distinct enumerated (version, path) pairs: pnpm 10.21 against the
// npm registry reported one path per finding with the count equal to both, and anything else (a hidden
// advisory, or a registry that counts differently) fails closed. Low, moderate and info do not block, so their
// count only has to lie between the number of findings and the number of paths.
function checkDeclaredCounts(declared: unknown, advisories: Advisory[]): ParsedReport["declared"] {
  if (
    !isRecord(declared) ||
    Object.keys(declared).length !== SEVERITIES.length ||
    !SEVERITIES.every((s) => Number.isSafeInteger(declared[s]) && (declared[s] as number) >= 0)
  ) {
    throw new ReportError(
      `metadata.vulnerabilities must hold non-negative integer counts for exactly ${SEVERITIES.join(", ")}`,
    );
  }
  for (const s of SEVERITIES) {
    const ofSeverity = advisories.filter((a) => a.severity === s);
    const findings = ofSeverity.reduce((n, a) => n + a.findings.length, 0);
    const paths = ofSeverity.reduce(
      (n, a) => n + a.findings.reduce((m, f) => m + f.paths.length, 0),
      0,
    );
    const count = declared[s] as number;
    const blocking = s === "high" || s === "critical";
    if (blocking ? count !== paths : count < findings || count > paths) {
      throw new ReportError(
        `declared ${s} count disagrees with the enumerated ${s} advisories (advisories hidden or ignored?)`,
      );
    }
  }
  return Object.fromEntries(
    SEVERITIES.map((s) => [s, declared[s] as number]),
  ) as ParsedReport["declared"];
}

function isAdvisory(a: unknown): a is Advisory {
  return (
    isRecord(a) &&
    Number.isSafeInteger(a.id) &&
    typeof a.module_name === "string" &&
    a.module_name !== "" &&
    typeof a.severity === "string" &&
    (SEVERITIES as readonly string[]).includes(a.severity) &&
    typeof a.github_advisory_id === "string" &&
    GHSA.test(a.github_advisory_id) &&
    isStringArray(a.cves) &&
    typeof a.patched_versions === "string" &&
    typeof a.vulnerable_versions === "string" &&
    Array.isArray(a.findings) &&
    a.findings.length > 0 &&
    a.findings.every(
      (f: unknown) =>
        isRecord(f) &&
        typeof f.version === "string" &&
        isStringArray(f.paths) &&
        f.paths.length > 0 &&
        f.paths.every((p) => p !== ""),
    )
  );
}
