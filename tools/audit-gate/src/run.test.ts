import { expect, test } from "vitest";
import { runGate, type GateDeps, type PnpmResult } from "./run.ts";
import {
  advisory,
  INSIDE_WINDOW,
  policy,
  report,
  ROOT_MANIFEST,
  syntheticAdvisory,
} from "../test/fixtures.ts";

function deps(over: Partial<GateDeps> = {}): GateDeps & { lines: string[]; calls: string[][] } {
  const lines: string[] = [];
  const calls: string[][] = [];
  const outputs: Record<string, PnpmResult> = {
    "--version": { status: 0, stdout: "10.21.0\n", stderr: "" },
    "audit --json --only=null --no-production --no-dev --optional": {
      status: 1,
      stdout: JSON.stringify(report([advisory()]), null, 2),
      stderr: "",
    },
    "audit --json --only=prod --production --no-dev --optional": {
      status: 0,
      stdout: JSON.stringify(report([])),
      stderr: "",
    },
  };
  return {
    lines,
    calls,
    runPnpm: (args) => {
      calls.push(args);
      const out = outputs[args.join(" ")];
      if (out === undefined) throw new Error(`unexpected pnpm ${args.join(" ")}`);
      return out;
    },
    readPolicy: () => JSON.stringify(policy()),
    readManifest: () => JSON.stringify(ROOT_MANIFEST),
    now: () => INSIDE_WINDOW,
    log: (line) => lines.push(line),
    ...over,
  };
}

test("runs the full and production audits, prints the full report and logs the accepted risk", () => {
  const d = deps();
  expect(runGate(d)).toBe(0);
  // Explicit scope flags: pnpm 10 lets inherited only/dev/production/optional settings narrow a bare
  // `pnpm audit`, and command-line settings take precedence over .npmrc, environment and workspace settings.
  expect(d.calls).toEqual([
    ["--version"],
    ["audit", "--json", "--only=null", "--no-production", "--no-dev", "--optional"],
    ["audit", "--json", "--only=prod", "--production", "--no-dev", "--optional"],
  ]);
  const out = d.lines.join("\n");
  expect(out).toContain(JSON.stringify(report([advisory()]), null, 2));
  expect(out).toContain(
    "ACCEPTED RISK (not fixed): high GHSA-fc5q-39xc-vjpf picomatch@4.0.7 via .>vitest>picomatch; owner shaangill025; expires 2026-12-02T03:27:59Z; tracking https://github.com/shaangill025/CiteSpark/issues/21",
  );
  expect(out).toContain(
    "Rationale: Synthetic rationale: reachable only through fixed, repository-controlled tool globs.",
  );
  expect(out).toContain(
    "Dependency audit gate PASSED only under a temporary exception; the audit is not clean and the advisory is not fixed.",
  );
});

test("fails closed on network errors, non-JSON output and a pnpm that could not run", () => {
  const cases: PnpmResult[] = [
    {
      status: 1,
      stdout: "",
      stderr:
        " ERR_PNPM_AUDIT_BAD_RESPONSE  The audit endpoint responded with 503: synthetic outage",
    },
    // auditConfig/ignoreRegistryErrors turns a registry failure into exit 0 with the message as plain text.
    {
      status: 0,
      stdout: "request to https://registry.example/ failed, reason: getaddrinfo ENOTFOUND",
      stderr: "",
    },
    { status: null, stdout: "", stderr: "" },
  ];
  for (const failing of cases) {
    const d = deps({
      runPnpm: (args) =>
        args[0] === "--version" ? { status: 0, stdout: "10.21.0\n", stderr: "" } : failing,
    });
    expect(runGate(d)).toBe(1);
    const out = d.lines.join("\n");
    expect(out).toContain("audit: full report rejected (fail closed): pnpm output is not JSON");
    if (failing.stderr !== "") expect(out).toContain(failing.stderr);
    expect(out).toContain("Dependency audit gate FAILED.");
  }
});

test("logs low and moderate findings and does not claim an exception when none was used", () => {
  const low = syntheticAdvisory(9010, "low");
  const d = deps({
    readPolicy: () => JSON.stringify(policy([])),
    runPnpm: (args) =>
      args[0] === "--version"
        ? { status: 0, stdout: "10.21.0\n", stderr: "" }
        : args.includes("--only=prod")
          ? { status: 0, stdout: JSON.stringify(report([])), stderr: "" }
          : { status: 1, stdout: JSON.stringify(report([low])), stderr: "" },
  });
  expect(runGate(d)).toBe(0);
  const out = d.lines.join("\n");
  expect(out).toContain(
    "reported (below high threshold): low GHSA-2222-3333-4444 synthetic-9010@1.0.0 via .>vitest>synthetic-9010",
  );
  expect(out).toContain("Dependency audit gate PASSED: no high or critical advisories.");
  expect(out).not.toContain("ACCEPTED RISK");
});

test("fails closed when the policy or root manifest cannot be read or parsed", () => {
  const missing = () => {
    throw new Error("ENOENT: synthetic missing file");
  };
  for (const over of [{ readPolicy: missing }, { readPolicy: () => "{not json" }]) {
    const d = deps(over);
    expect(runGate(d)).toBe(1);
    expect(d.lines).toContain("policy: cannot read or parse the exception policy (fail closed)");
    expect(d.lines.join("\n")).toContain(JSON.stringify(report([advisory()]), null, 2));
  }
  for (const over of [{ readManifest: missing }, { readManifest: () => "" }]) {
    const d = deps(over);
    expect(runGate(d)).toBe(1);
    expect(d.lines).toContain(
      "manifest: root package.json dependency fields are malformed (fail closed)",
    );
  }
});

test("prints the production-only audit report it relied on for the development scope", () => {
  const d = deps();
  runGate(d);
  expect(d.lines).toContain(
    "$ pnpm audit --json --only=prod --production --no-dev --optional (exit 0)",
  );
  expect(d.lines).toContain(JSON.stringify(report([])));
});

test("fails closed unless pnpm is the version pinned in packageManager, the one the scope flags were verified with", () => {
  for (const version of [
    { status: 0, stdout: "10.22.0\n", stderr: "" },
    { status: 0, stdout: "9.15.0\n", stderr: "" },
    { status: null, stdout: "", stderr: "failed to run pnpm: spawn pnpm ENOENT" },
  ]) {
    const base = deps();
    const d = deps({ runPnpm: (args) => (args[0] === "--version" ? version : base.runPnpm(args)) });
    expect(runGate(d)).toBe(1);
    expect(d.lines).toContain(
      `pnpm: version ${JSON.stringify(version.stdout.trim())} is not the pinned packageManager pnpm@10.21.0; the audit scope flags are verified only for the pinned pnpm (fail closed)`,
    );
    expect(d.lines).toContain("Dependency audit gate FAILED.");
  }
  for (const manifest of [
    { ...ROOT_MANIFEST, packageManager: undefined },
    { ...ROOT_MANIFEST, packageManager: "npm@10.0.0" },
  ]) {
    const d = deps({ readManifest: () => JSON.stringify(manifest) });
    expect(runGate(d)).toBe(1);
    expect(d.lines.join("\n")).toContain("is not the pinned packageManager");
  }
});
