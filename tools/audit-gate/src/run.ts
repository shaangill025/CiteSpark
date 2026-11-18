// Runs the full pnpm audit and the production-only audit, prints both reports unchanged and applies the
// reviewed exception policy. The command lines are fixed and set the dependency scope explicitly; other pnpm
// settings (registry, authentication, TLS, auditConfig) are inherited as usual.
import { evaluateAudit } from "./evaluate.ts";
import { NOT_JSON } from "./report.ts";

export interface PnpmResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export interface GateDeps {
  runPnpm: (args: string[]) => PnpmResult;
  readPolicy: () => string;
  readManifest: () => string;
  now: () => Date;
  log: (line: string) => void;
}

// pnpm 10 derives an audit's dependency scope from the only, production, dev and optional settings, which a
// bare `pnpm audit` inherits from .npmrc files, npm_config_* environment variables and pnpm-workspace.yaml
// (for example optional=false drops optional dependencies from both audits, and dev=true or only=dev turns the
// "full" audit into a development-only one). Command-line settings take precedence over all of those, so both
// audits set every one of them explicitly. In pnpm 10.21's config normalisation, only=null with production and
// dev unset selects production and development dependencies, and only=prod selects production without
// development ones; --optional adds optional dependencies to both. The request scope this produces is checked
// end to end with the real pnpm in test/real-pnpm.test.ts.
export const FULL_AUDIT = [
  "audit",
  "--json",
  "--only=null",
  "--no-production",
  "--no-dev",
  "--optional",
];
export const PROD_AUDIT = [
  "audit",
  "--json",
  "--only=prod",
  "--production",
  "--no-dev",
  "--optional",
];
export const PNPM_VERSION = ["--version"];

export function runGate(deps: GateDeps): number {
  // The scope flags above are verified against the pinned pnpm only; any other pnpm fails closed.
  const version = deps.runPnpm(PNPM_VERSION);
  const pinned = pinnedPnpm(readJson(deps.readManifest));
  const actual = version.status === 0 ? version.stdout.trim() : "";
  const versionError =
    pinned !== undefined && actual === pinned
      ? undefined
      : `pnpm: version ${JSON.stringify(actual)} is not the pinned packageManager pnpm@${pinned ?? "<missing>"}; the audit scope flags are verified only for the pinned pnpm (fail closed)`;
  if (version.stderr !== "") deps.log(version.stderr);
  const full = deps.runPnpm(FULL_AUDIT);
  deps.log(`$ pnpm ${FULL_AUDIT.join(" ")} (exit ${String(full.status)})`);
  deps.log(full.stdout);
  if (full.stderr !== "") deps.log(full.stderr);
  const prod = deps.runPnpm(PROD_AUDIT);
  deps.log(`$ pnpm ${PROD_AUDIT.join(" ")} (exit ${String(prod.status)})`);
  deps.log(prod.stdout);
  if (prod.stderr !== "") deps.log(prod.stderr);
  const policy = readJson(deps.readPolicy);
  if (policy === NOT_JSON)
    deps.log("policy: cannot read or parse the exception policy (fail closed)");
  const result = evaluateAudit({
    policy,
    full: { exitCode: full.status ?? -1, json: parseJson(full.stdout) },
    prod: { exitCode: prod.status ?? -1, json: parseJson(prod.stdout) },
    manifest: readJson(deps.readManifest),
    now: deps.now(),
  });
  if (versionError !== undefined) {
    result.ok = false;
    result.errors.unshift(versionError);
  }
  for (const r of result.reported) deps.log(r);
  for (const a of result.accepted) {
    const e = a.exception;
    deps.log(
      `ACCEPTED RISK (not fixed): ${e.severity} ${a.advisory} ${a.module}@${a.version} via ${a.path}; owner ${e.owner}; expires ${e.expiresAt}; tracking ${e.tracking}`,
    );
  }
  for (const e of new Set(result.accepted.map((a) => a.exception)))
    deps.log(`Rationale: ${e.rationale}`);
  if (result.ok && result.accepted.length === 0) {
    deps.log("Dependency audit gate PASSED: no high or critical advisories.");
    return 0;
  }
  if (result.ok) {
    deps.log(
      "Dependency audit gate PASSED only under a temporary exception; the audit is not clean and the advisory is not fixed.",
    );
    return 0;
  }
  for (const e of result.errors) deps.log(e);
  deps.log("Dependency audit gate FAILED.");
  return 1;
}

function pinnedPnpm(manifest: unknown): string | undefined {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const pin = (manifest as Record<string, unknown>).packageManager;
  const match = typeof pin === "string" ? /^pnpm@(10\.\d+\.\d+)$/.exec(pin) : null;
  return match?.[1];
}

function readJson(read: () => string): unknown {
  try {
    return parseJson(read());
  } catch {
    return NOT_JSON;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return NOT_JSON;
  }
}
