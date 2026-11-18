import { expect, test } from "vitest";
import { evaluateAudit, type GateInput } from "./evaluate.ts";
import {
  advisory,
  CREATED_AT,
  exception,
  INSIDE_WINDOW,
  policy,
  report,
  ROOT_MANIFEST,
  syntheticAdvisory,
} from "../test/fixtures.ts";

function without<T extends object>(value: T, key: keyof T): Partial<T> {
  const copy: Partial<T> = { ...value };
  delete copy[key];
  return copy;
}

function input(over: Partial<GateInput> = {}): GateInput {
  const full = report([advisory()]);
  return {
    policy: policy(),
    full: { exitCode: 1, json: full },
    prod: { exitCode: 0, json: report([]) },
    manifest: ROOT_MANIFEST,
    now: INSIDE_WINDOW,
    ...over,
  };
}

test("accepts only the two reviewed picomatch development findings inside the window", () => {
  const result = evaluateAudit(input());
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.accepted.map((a) => `${a.version} ${a.path}`)).toEqual([
    "2.3.2 .>typescript-eslint>@typescript-eslint/typescript-estree>fast-glob>micromatch>picomatch",
    "4.0.7 .>vitest>picomatch",
  ]);
});

test("keeps every other high or critical advisory blocking", () => {
  const full = report([
    advisory(),
    syntheticAdvisory(9001, "high"),
    syntheticAdvisory(9002, "critical", { github_advisory_id: "GHSA-5555-6666-7777" }),
  ]);
  const result = evaluateAudit(input({ full: { exitCode: 1, json: full } }));
  expect(result.ok).toBe(false);
  expect(result.errors).toEqual([
    "blocked: high GHSA-2222-3333-4444 synthetic-9001@1.0.0 via .>vitest>synthetic-9001",
    "blocked: critical GHSA-5555-6666-7777 synthetic-9002@1.0.0 via .>vitest>synthetic-9002",
  ]);
  expect(result.accepted).toHaveLength(2);
});

test("reports low and moderate advisories without blocking, as the high threshold did", () => {
  const full = report([
    advisory(),
    syntheticAdvisory(9003, "low"),
    syntheticAdvisory(9004, "moderate"),
  ]);
  const result = evaluateAudit(input({ full: { exitCode: 1, json: full } }));
  expect(result.errors).toEqual([]);
  expect(result.ok).toBe(true);
  expect(result.reported).toEqual([
    "reported (below high threshold): low GHSA-2222-3333-4444 synthetic-9003@1.0.0 via .>vitest>synthetic-9003",
    "reported (below high threshold): moderate GHSA-2222-3333-4444 synthetic-9004@1.0.0 via .>vitest>synthetic-9004",
  ]);
});

test("the exception ends exactly at expiresAt (UTC)", () => {
  const at = (iso: string) => evaluateAudit(input({ now: new Date(iso) }));
  expect(at("2026-12-02T03:27:58.999Z").ok).toBe(true);
  const exact = at("2026-12-02T03:27:59.000Z");
  expect(exact.ok).toBe(false);
  expect(exact.accepted).toEqual([]);
  expect(exact.errors).toContain(
    "policy: exception GHSA-fc5q-39xc-vjpf expired at 2026-12-02T03:27:59Z; renewal needs new explicit owner approval (tracking https://github.com/shaangill025/CiteSpark/issues/21)",
  );
  expect(at("2026-12-09T00:00:00Z").ok).toBe(false);
});

test("a healthy empty report still fails while the exception is listed, so it cannot linger quietly", () => {
  const clean = { exitCode: 0, json: report([]) };
  const inside = evaluateAudit(input({ full: clean }));
  expect(inside.ok).toBe(false);
  expect(inside.errors).toEqual([
    "stale: exception GHSA-fc5q-39xc-vjpf reviewed picomatch@2.3.2 via .>typescript-eslint>@typescript-eslint/typescript-estree>fast-glob>micromatch>picomatch, which the audit no longer reports; remove or narrow the exception",
    "stale: exception GHSA-fc5q-39xc-vjpf reviewed picomatch@4.0.7 via .>vitest>picomatch, which the audit no longer reports; remove or narrow the exception",
  ]);
  const expired = evaluateAudit(input({ full: clean, now: new Date("2026-12-03T00:00:00Z") }));
  expect(expired.ok).toBe(false);
  expect(expired.errors[0]).toMatch(/^policy: exception GHSA-fc5q-39xc-vjpf expired/);
});

test("refuses the whole advisory when it also reaches a new unreviewed path or version", () => {
  for (const extra of [
    { version: "4.0.7", paths: [".>vitest>vite>tinyglobby>picomatch"] },
    { version: "4.0.6", paths: [".>vitest>picomatch"] },
  ]) {
    const a = advisory();
    const full = report([advisory({ findings: [...a.findings, extra] })]);
    const result = evaluateAudit(input({ full: { exitCode: 1, json: full } }));
    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.errors).toContain(
      `blocked: high GHSA-fc5q-39xc-vjpf picomatch@${extra.version} via ${extra.paths[0]} (not a reviewed finding of the exception)`,
    );
    expect(result.errors).toContain(
      "blocked: high GHSA-fc5q-39xc-vjpf picomatch@4.0.7 via .>vitest>picomatch (exception refused for the whole advisory)",
    );
  }
});

test("refuses the exception when the advisory's package, severity or CVE differs from the reviewed one", () => {
  for (const over of [
    { module_name: "micromatch" },
    { severity: "critical" },
    { cves: ["CVE-2026-999999"] },
  ]) {
    const full = report([advisory(over)]);
    const result = evaluateAudit(input({ full: { exitCode: 1, json: full } }));
    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(
      result.errors.some((e) =>
        e.endsWith("(advisory identity differs from the reviewed exception)"),
      ),
    ).toBe(true);
  }
});

test("refuses the exception when the production-only audit also reports the advisory", () => {
  const prodAdvisory = advisory({
    findings: [{ version: "4.0.7", paths: [".>vitest>picomatch"] }],
  });
  const result = evaluateAudit(input({ prod: { exitCode: 1, json: report([prodAdvisory]) } }));
  expect(result.ok).toBe(false);
  expect(result.accepted).toEqual([]);
  expect(result.errors).toContain(
    "blocked: high GHSA-fc5q-39xc-vjpf picomatch@4.0.7 via .>vitest>picomatch (the production-only audit reports this advisory)",
  );
});

test("refuses a reviewed path whose root package is not solely a root devDependency", () => {
  for (const manifest of [
    { devDependencies: { "typescript-eslint": "8.46.4" } },
    { dependencies: { vitest: "^4.0.0" }, devDependencies: ROOT_MANIFEST.devDependencies },
    { optionalDependencies: { vitest: "^4.0.0" }, devDependencies: ROOT_MANIFEST.devDependencies },
    { peerDependencies: { vitest: "^4.0.0" }, devDependencies: ROOT_MANIFEST.devDependencies },
  ]) {
    const result = evaluateAudit(input({ manifest }));
    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.errors).toContain(
      "blocked: high GHSA-fc5q-39xc-vjpf picomatch@4.0.7 via .>vitest>picomatch (root package vitest is not solely a root devDependency)",
    );
  }
});

test("refuses the exception once the advisory lists a patched version, so the upgrade is not deferred", () => {
  const full = report([advisory({ patched_versions: ">=4.0.8" })]);
  const result = evaluateAudit(input({ full: { exitCode: 1, json: full } }));
  expect(result.ok).toBe(false);
  expect(result.accepted).toEqual([]);
  expect(result.errors).toContain(
    "blocked: high GHSA-fc5q-39xc-vjpf picomatch@4.0.7 via .>vitest>picomatch (a patched version >=4.0.8 is now published; upgrade and remove the exception)",
  );
});

function expectPolicyRejected(policyValue: unknown, reason: string): void {
  const result = evaluateAudit(input({ policy: policyValue }));
  expect(result.ok).toBe(false);
  expect(result.accepted).toEqual([]);
  expect(result.errors).toContain(`policy: ${reason}`);
  expect(result.errors).toContain(
    "blocked: high GHSA-fc5q-39xc-vjpf picomatch@4.0.7 via .>vitest>picomatch",
  );
}

test("rejects a policy with a missing, extra or malformed field and applies no exception", () => {
  const noOwner = without(exception(), "owner");
  expectPolicyRejected(policy([noOwner]), "exception #1: owner must be a GitHub login");
  expectPolicyRejected(
    policy([exception({ ignoreAll: true })]),
    "exception #1: unknown field ignoreAll",
  );
  expectPolicyRejected(
    policy([exception({ scope: "production" })]),
    'exception #1: scope must be "development"',
  );
  expectPolicyRejected(
    policy([exception({ module: "micromatch" })]),
    "exception #1: finding paths must be root development paths ending in >micromatch",
  );
  expectPolicyRejected(
    policy([exception({ severity: "moderate" })]),
    "exception #1: severity must be high or critical",
  );
  expectPolicyRejected(
    policy([exception({ advisory: "GHSA-*" })]),
    "exception #1: advisory must be a GHSA identifier",
  );
  expectPolicyRejected(
    policy([exception({ findings: [] })]),
    "exception #1: findings must be a non-empty list of {version, path}",
  );
  expectPolicyRejected(
    policy([exception({ rationale: "" })]),
    "exception #1: rationale must be a non-empty explanation",
  );
  expectPolicyRejected(
    policy([exception(), exception()]),
    "exception #2: duplicate advisory GHSA-fc5q-39xc-vjpf",
  );
  expectPolicyRejected(
    { schemaVersion: 2, exceptions: [exception()] },
    "schemaVersion must be 1 with only an exceptions list",
  );
  expectPolicyRejected(null, "schemaVersion must be 1 with only an exceptions list");
});

test("rejects invalid, future-dated or longer-than-14-day exception windows", () => {
  const window =
    "exception #1: createdAt and expiresAt must be exact UTC seconds (YYYY-MM-DDTHH:MM:SSZ)";
  expectPolicyRejected(policy([exception({ expiresAt: "2026-02-30T00:00:00Z" })]), window);
  expectPolicyRejected(policy([exception({ expiresAt: "2026-12-02T03:27:59+00:00" })]), window);
  expectPolicyRejected(policy([exception({ createdAt: 1763436479000 })]), window);
  expectPolicyRejected(policy([exception({ expiresAt: "Infinity" })]), window);
  expectPolicyRejected(
    policy([exception({ expiresAt: "2026-12-02T03:28:00Z" })]),
    "exception #1: expiresAt must be after createdAt and at most 14 days later",
  );
  expectPolicyRejected(
    policy([exception({ expiresAt: CREATED_AT })]),
    "exception #1: expiresAt must be after createdAt and at most 14 days later",
  );
  expectPolicyRejected(
    policy([exception({ createdAt: "2026-11-21T00:00:00Z", expiresAt: "2026-12-01T00:00:00Z" })]),
    "exception #1: createdAt 2026-11-21T00:00:00Z is in the future",
  );
});

test("requires a tracking issue in this repository", () => {
  const reason = "exception #1: tracking must be an issue URL in shaangill025/CiteSpark";
  for (const tracking of [
    undefined,
    "",
    "https://github.com/shaangill025/CiteSpark/pull/16",
    "https://github.com/someone-else/CiteSpark/issues/21",
    "https://github.com/shaangill025/CiteSpark/issues/21#later",
  ]) {
    expectPolicyRejected(policy([exception({ tracking })]), reason);
  }
});

function expectFullRejected(json: unknown, detail: string, exitCode = 1): void {
  const result = evaluateAudit(input({ full: { exitCode, json } }));
  expect(result.ok).toBe(false);
  expect(result.accepted).toEqual([]);
  expect(result.errors).toContain(`audit: full report rejected (fail closed): ${detail}`);
}

test("fails closed on a report shape it does not recognise", () => {
  const shape = "not a pnpm 10 audit report {actions, advisories, muted, metadata}";
  expectFullRejected(null, shape);
  expectFullRejected("ERR_PNPM_AUDIT_BAD_RESPONSE", shape);
  expectFullRejected({ ...report([advisory()]), error: { code: "ENOTFOUND" } }, shape);
  const noMuted = without(report([advisory()]), "muted");
  expectFullRejected(noMuted, shape);
  const noFindings = advisory({ findings: [] });
  expectFullRejected(report([noFindings]), "advisory 1247710 is malformed");
  const badKey = report([advisory()]);
  badKey.advisories = { "42": advisory() };
  expectFullRejected(badKey, "advisory 42 is malformed");
  const noGhsa = without(advisory(), "github_advisory_id") as ReturnType<typeof advisory>;
  expectFullRejected(report([noGhsa]), "advisory 1247710 is malformed");
  expectFullRejected(
    { ...report([advisory()]), muted: [{ id: 1247710 }] },
    "muted advisories are not supported",
  );
});

test("fails closed on an advisory severity outside info, low, moderate, high and critical", () => {
  for (const severity of ["severe", "HIGH", ""]) {
    expectFullRejected(
      report([syntheticAdvisory(9005, severity), advisory()]),
      "advisory 9005 is malformed",
    );
  }
});

test("fails closed when declared severity counts are missing or disagree with the enumerated advisories", () => {
  const withCounts = (vulnerabilities: unknown, advisories = [advisory()]) => {
    const r = report(advisories);
    (r.metadata as Record<string, unknown>).vulnerabilities = vulnerabilities;
    return r;
  };
  const counts =
    "metadata.vulnerabilities must hold non-negative integer counts for exactly info, low, moderate, high, critical";
  expectFullRejected(withCounts(undefined), counts);
  expectFullRejected(withCounts({ low: 0, moderate: 0, high: 2, critical: 0 }), counts);
  expectFullRejected(withCounts({ info: 0, low: 0, moderate: 0, high: "2", critical: 0 }), counts);
  expectFullRejected(withCounts({ info: 0, low: 0, moderate: 0, high: 2.5, critical: 0 }), counts);
  expectFullRejected(
    withCounts({ info: 0, low: 0, moderate: 0, high: 2, critical: 0, severe: 0 }),
    counts,
  );
  const mismatch = (s: string) =>
    `declared ${s} count disagrees with the enumerated ${s} advisories (advisories hidden or ignored?)`;
  // A GHSA filtered out by pnpm's auditConfig.ignoreGhsas keeps its count but loses its advisory entry.
  expectFullRejected(
    withCounts({ info: 0, low: 0, moderate: 0, high: 2, critical: 0 }, []),
    mismatch("high"),
  );
  expectFullRejected(
    withCounts({ info: 0, low: 0, moderate: 0, high: 3, critical: 0 }),
    mismatch("high"),
  );
  expectFullRejected(
    withCounts({ info: 0, low: 0, moderate: 0, high: 1, critical: 0 }),
    mismatch("high"),
  );
  expectFullRejected(
    withCounts({ info: 0, low: 0, moderate: 0, high: 2, critical: 1 }),
    mismatch("critical"),
  );
});

test("fails closed when the pnpm exit status disagrees with the report or is unexpected", () => {
  const exit = (code: number) =>
    `pnpm audit exited ${code}, expected 1 when vulnerabilities are counted and 0 otherwise`;
  // Exit 0 alone is never trusted: a report that counts findings must come with exit 1.
  expectFullRejected(report([advisory()]), exit(0), 0);
  expectFullRejected(report([]), exit(1), 1);
  expectFullRejected(report([advisory()]), exit(2), 2);
  expectFullRejected(report([advisory()]), exit(-1), -1);
  const prod = evaluateAudit(input({ prod: { exitCode: 1, json: report([]) } }));
  expect(prod.ok).toBe(false);
  expect(prod.accepted).toEqual([]);
  expect(prod.errors).toContain(`audit: production-only report rejected (fail closed): ${exit(1)}`);
});

test("fails closed on a root manifest whose dependency fields are not plain objects", () => {
  for (const manifest of [
    null,
    "{}",
    { devDependencies: ["vitest"] },
    { ...ROOT_MANIFEST, dependencies: "x" },
  ]) {
    const result = evaluateAudit(input({ manifest }));
    expect(result.ok).toBe(false);
    expect(result.accepted).toEqual([]);
    expect(result.errors).toContain(
      "manifest: root package.json dependency fields are malformed (fail closed)",
    );
  }
});
