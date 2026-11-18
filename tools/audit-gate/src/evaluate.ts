import { parsePolicy, type AuditException } from "./policy.ts";
import {
  parseReport,
  ReportError,
  SEVERITIES,
  type Advisory,
  type ParsedReport,
} from "./report.ts";

// Pure evaluation of a pnpm 10 audit report against the reviewed temporary exceptions policy.

export interface AuditRun {
  exitCode: number;
  json: unknown;
}

export interface GateInput {
  policy: unknown;
  full: AuditRun;
  prod: AuditRun;
  manifest: unknown;
  now: Date;
}

export interface AcceptedFinding {
  exception: AuditException;
  advisory: string;
  module: string;
  version: string;
  path: string;
}

export interface GateResult {
  ok: boolean;
  errors: string[];
  accepted: AcceptedFinding[];
  reported: string[];
}

type Exception = AuditException;

// pnpm 10 prints this range when the advisory has no patched release.
const NO_PATCH = "<0.0.0";

export function evaluateAudit(input: GateInput): GateResult {
  const errors: string[] = [];
  const accepted: AcceptedFinding[] = [];
  const reported: string[] = [];
  const exceptions = activeExceptions(input.policy, input.now, errors);
  const fullReport = readReport("full", input.full, errors);
  const prodReport = readReport("production-only", input.prod, errors);
  const manifestOk = isWellFormedManifest(input.manifest);
  if (!manifestOk)
    errors.push("manifest: root package.json dependency fields are malformed (fail closed)");
  if (fullReport === undefined || prodReport === undefined || !manifestOk) {
    return { ok: false, errors, accepted, reported };
  }
  const advisories = fullReport.advisories;
  const prodAdvisories = prodReport.advisories;
  const inProduction = new Set(prodAdvisories.map((a) => a.github_advisory_id));
  const observed = new Set<string>();
  for (const a of advisories) {
    for (const i of itemsOf(a)) observed.add(key(a.github_advisory_id, i.version, i.path));
  }
  // The production-only report is evaluated on its own: exceptions cover development findings only, so every
  // high or critical finding it reports blocks, whether or not the full report also lists it.
  for (const a of prodAdvisories) {
    for (const i of itemsOf(a)) {
      if (a.severity === "high" || a.severity === "critical") {
        errors.push(
          `blocked: ${labelOf(a, i)} (reported by the production-only audit; exceptions cover development findings only)`,
        );
      }
    }
  }
  checkScope(fullReport, prodReport, observed, errors);
  for (const a of advisories) {
    const items = itemsOf(a);
    const label = (i: Item) => labelOf(a, i);
    if (a.severity !== "high" && a.severity !== "critical") {
      for (const i of items) reported.push(`reported (below high threshold): ${label(i)}`);
      continue;
    }
    const exc = exceptions.find((e) => e.advisory === a.github_advisory_id);
    if (exc === undefined) {
      for (const i of items) errors.push(`blocked: ${label(i)}`);
      continue;
    }
    const reasons = new Map<(typeof items)[number], string>();
    let refusal: string | undefined;
    if (a.module_name !== exc.module || a.severity !== exc.severity || !a.cves.includes(exc.cve)) {
      refusal = "advisory identity differs from the reviewed exception";
    } else if (a.patched_versions !== NO_PATCH) {
      refusal = `a patched version ${a.patched_versions} is now published; upgrade and remove the exception`;
    } else if (inProduction.has(a.github_advisory_id)) {
      refusal = "the production-only audit reports this advisory";
    }
    for (const i of items) {
      if (!exc.findings.some((r) => r.version === i.version && r.path === i.path)) {
        reasons.set(i, "not a reviewed finding of the exception");
        continue;
      }
      const root = i.path.split(">")[1] ?? "";
      if (!isSolelyDevDependency(input.manifest, root)) {
        reasons.set(i, `root package ${root} is not solely a root devDependency`);
      }
    }
    if (refusal !== undefined || reasons.size > 0) {
      for (const i of items) {
        errors.push(
          `blocked: ${label(i)} (${reasons.get(i) ?? refusal ?? "exception refused for the whole advisory"})`,
        );
      }
      continue;
    }
    for (const i of items) {
      accepted.push({
        exception: exc,
        advisory: a.github_advisory_id,
        module: a.module_name,
        ...i,
      });
    }
  }
  for (const e of exceptions) {
    for (const r of e.findings) {
      if (!observed.has(key(e.advisory, r.version, r.path))) {
        errors.push(
          `stale: exception ${e.advisory} reviewed ${e.module}@${r.version} via ${r.path}, which the audit no longer reports; remove or narrow the exception`,
        );
      }
    }
  }
  return { ok: errors.length === 0, errors, accepted, reported };
}

interface Item {
  version: string;
  path: string;
}

function itemsOf(a: Advisory): Item[] {
  return a.findings.flatMap((f) => f.paths.map((path) => ({ version: f.version, path })));
}

function labelOf(a: Advisory, i: Item): string {
  return `${a.severity} ${a.github_advisory_id} ${a.module_name}@${i.version} via ${i.path}`;
}

// The full audit must include production, development and optional dependencies, so it must be a superset of
// the production-only audit: every production finding and at least as many vulnerabilities per severity.
function checkScope(
  full: ParsedReport,
  prod: ParsedReport,
  observed: Set<string>,
  errors: string[],
): void {
  const scope =
    "the full audit must cover production, development and optional dependencies (fail closed)";
  for (const a of prod.advisories) {
    for (const i of itemsOf(a)) {
      if (!observed.has(key(a.github_advisory_id, i.version, i.path))) {
        errors.push(
          `scope: the production-only audit reports ${labelOf(a, i)}, which the full audit does not; ${scope}`,
        );
      }
    }
  }
  for (const s of SEVERITIES) {
    if (prod.declared[s] > full.declared[s]) {
      errors.push(
        `scope: the production-only audit counts ${String(prod.declared[s])} ${s} vulnerabilities but the full audit counts ${String(full.declared[s])}; ${scope}`,
      );
    }
  }
}

function readReport(name: string, run: AuditRun, errors: string[]): ParsedReport | undefined {
  try {
    return parseReport(run.json, run.exitCode);
  } catch (err) {
    if (!(err instanceof ReportError)) throw err;
    errors.push(`audit: ${name} report rejected (fail closed): ${err.message}`);
    return undefined;
  }
}

function key(advisory: string, version: string, path: string): string {
  return JSON.stringify([advisory, version, path]);
}

function activeExceptions(policy: unknown, now: Date, errors: string[]): Exception[] {
  const active: Exception[] = [];
  const parsed = parsePolicy(policy, now);
  for (const e of parsed.errors) errors.push(`policy: ${e}`);
  for (const e of parsed.exceptions) {
    if (now.getTime() >= Date.parse(e.expiresAt)) {
      errors.push(
        `policy: exception ${e.advisory} expired at ${e.expiresAt}; renewal needs new explicit owner approval (tracking ${e.tracking})`,
      );
      continue;
    }
    active.push(e);
  }
  return active;
}

const NON_DEV_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

function isWellFormedManifest(manifest: unknown): boolean {
  if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) return false;
  const m = manifest as Record<string, unknown>;
  return [...NON_DEV_FIELDS, "devDependencies"].every((field) => {
    const v = m[field];
    return v === undefined || (typeof v === "object" && v !== null && !Array.isArray(v));
  });
}

function isSolelyDevDependency(manifest: unknown, name: string): boolean {
  const m = manifest as Record<string, Record<string, unknown> | undefined>;
  if (!Object.hasOwn(m.devDependencies ?? {}, name)) return false;
  return NON_DEV_FIELDS.every((field) => !Object.hasOwn(m[field] ?? {}, name));
}
