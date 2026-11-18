import { parsePolicy, type AuditException } from "./policy.ts";
import { parseReport, ReportError, type Advisory } from "./report.ts";

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
  const advisories = readReport("full", input.full, errors);
  const prodAdvisories = readReport("production-only", input.prod, errors);
  const manifestOk = isWellFormedManifest(input.manifest);
  if (!manifestOk)
    errors.push("manifest: root package.json dependency fields are malformed (fail closed)");
  if (advisories === undefined || prodAdvisories === undefined || !manifestOk) {
    return { ok: false, errors, accepted, reported };
  }
  const inProduction = new Set(prodAdvisories.map((a) => a.github_advisory_id));
  const observed = new Set<string>();
  for (const a of advisories) {
    const items = a.findings.flatMap((f) => f.paths.map((path) => ({ version: f.version, path })));
    const label = (i: { version: string; path: string }) =>
      `${a.severity} ${a.github_advisory_id} ${a.module_name}@${i.version} via ${i.path}`;
    for (const i of items) observed.add(key(a.github_advisory_id, i.version, i.path));
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

function readReport(name: string, run: AuditRun, errors: string[]): Advisory[] | undefined {
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
