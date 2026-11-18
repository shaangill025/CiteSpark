// Runs the full pnpm audit and the production-only audit, prints the full report unchanged and applies the
// reviewed exception policy. The command line is fixed; nothing from the environment selects what runs.
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

export const FULL_AUDIT = ["audit", "--json"];
export const PROD_AUDIT = ["audit", "--prod", "--json"];

export function runGate(deps: GateDeps): number {
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
