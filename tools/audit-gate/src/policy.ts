// Strict validation of the reviewed temporary audit exception policy (tools/audit-gate/audit-exceptions.json).
// Any problem rejects the whole policy so that no exception applies.

export interface ReviewedFinding {
  version: string;
  path: string;
}

export interface AuditException {
  advisory: string;
  cve: string;
  module: string;
  severity: "high" | "critical";
  scope: "development";
  findings: ReviewedFinding[];
  owner: string;
  createdAt: string;
  expiresAt: string;
  tracking: string;
  rationale: string;
}

const FIELDS = [
  "advisory",
  "cve",
  "module",
  "severity",
  "scope",
  "findings",
  "owner",
  "createdAt",
  "expiresAt",
  "tracking",
  "rationale",
] as const;

const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const CVE = /^CVE-\d{4}-\d{4,}$/;
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MAX_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const TRACKING = /^https:\/\/github\.com\/shaangill025\/CiteSpark\/issues\/[1-9]\d*$/;
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

// Returns the exceptions, or an empty list plus errors when anything is malformed.
export function parsePolicy(
  raw: unknown,
  now: Date,
): { exceptions: AuditException[]; errors: string[] } {
  const errors: string[] = [];
  if (
    !isRecord(raw) ||
    raw.schemaVersion !== 1 ||
    !Array.isArray(raw.exceptions) ||
    Object.keys(raw).some((k) => k !== "schemaVersion" && k !== "exceptions")
  ) {
    return { exceptions: [], errors: ["schemaVersion must be 1 with only an exceptions list"] };
  }
  const seen = new Set<string>();
  raw.exceptions.forEach((entry: unknown, index) => {
    const problems = exceptionProblems(entry, now);
    if (problems.length === 0 && isRecord(entry) && isString(entry.advisory)) {
      if (seen.has(entry.advisory)) problems.push(`duplicate advisory ${entry.advisory}`);
      seen.add(entry.advisory);
    }
    for (const p of problems) errors.push(`exception #${index + 1}: ${p}`);
  });
  if (errors.length > 0) return { exceptions: [], errors };
  return { exceptions: raw.exceptions as AuditException[], errors };
}

function exceptionProblems(e: unknown, now: Date): string[] {
  if (!isRecord(e)) return ["must be an object"];
  const problems: string[] = [];
  for (const k of Object.keys(e)) {
    if (!(FIELDS as readonly string[]).includes(k)) problems.push(`unknown field ${k}`);
  }
  if (!isString(e.advisory) || !GHSA.test(e.advisory))
    problems.push("advisory must be a GHSA identifier");
  if (!isString(e.cve) || !CVE.test(e.cve)) problems.push("cve must be a CVE identifier");
  const module = isString(e.module) && NPM_NAME.test(e.module) ? e.module : undefined;
  if (module === undefined) problems.push("module must be an npm package name");
  if (e.severity !== "high" && e.severity !== "critical")
    problems.push("severity must be high or critical");
  if (e.scope !== "development") problems.push('scope must be "development"');
  if (
    !Array.isArray(e.findings) ||
    e.findings.length === 0 ||
    !e.findings.every(
      (f: unknown) =>
        isRecord(f) &&
        Object.keys(f).length === 2 &&
        isString(f.version) &&
        VERSION.test(f.version) &&
        isString(f.path),
    )
  ) {
    problems.push("findings must be a non-empty list of {version, path}");
  } else if (
    module !== undefined &&
    !(e.findings as ReviewedFinding[]).every((f) => isRootPathTo(f.path, module))
  ) {
    problems.push(`finding paths must be root development paths ending in >${module}`);
  }
  const created = utcSeconds(e.createdAt);
  const expires = utcSeconds(e.expiresAt);
  if (created === undefined || expires === undefined) {
    problems.push("createdAt and expiresAt must be exact UTC seconds (YYYY-MM-DDTHH:MM:SSZ)");
  } else {
    if (expires <= created || expires - created > MAX_WINDOW_MS) {
      problems.push("expiresAt must be after createdAt and at most 14 days later");
    }
    if (created > now.getTime()) problems.push(`createdAt ${String(e.createdAt)} is in the future`);
  }
  if (!isString(e.owner) || !LOGIN.test(e.owner)) problems.push("owner must be a GitHub login");
  if (!isString(e.tracking) || !TRACKING.test(e.tracking)) {
    problems.push("tracking must be an issue URL in shaangill025/CiteSpark");
  }
  if (!isString(e.rationale) || e.rationale.trim() === "") {
    problems.push("rationale must be a non-empty explanation");
  }
  return problems;
}

// ".>root>...>module": starts at the workspace root importer, every segment is a package name.
function isRootPathTo(path: string, module: string): boolean {
  const segments = path.split(">");
  return (
    segments.length >= 3 &&
    segments[0] === "." &&
    segments.slice(1).every((s) => NPM_NAME.test(s)) &&
    segments[segments.length - 1] === module
  );
}

// Milliseconds for a canonical "YYYY-MM-DDTHH:MM:SSZ" timestamp; undefined for anything else, including
// calendar overflow such as February 30 that Date.parse would silently roll over.
function utcSeconds(value: unknown): number | undefined {
  if (!isString(value) || !UTC_SECONDS.test(value)) return undefined;
  const ms = Date.parse(value);
  if (!Number.isFinite(ms) || new Date(ms).toISOString() !== value.replace("Z", ".000Z"))
    return undefined;
  return ms;
}
