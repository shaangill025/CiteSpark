// End-to-end: runs the real CLI exactly as the package script does, against a stub `pnpm` on PATH that
// prints synthetic pnpm 10 JSON. The tool is copied into a temporary repository so the policy dates can be
// set relative to the real clock without any clock override in the CLI.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, expect, test } from "vitest";
import {
  advisory,
  exception,
  policy,
  report,
  ROOT_MANIFEST,
  syntheticAdvisory,
} from "./fixtures.ts";

const TOOL = join(import.meta.dirname, "..");
const REPO = join(TOOL, "..", "..");
const SCRIPT = (
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  }
).scripts["audit-gate"];

// ES module: the temporary repository's package.json declares "type": "module".
const STUB = `#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
const dir = path.join(import.meta.dirname, "..", "stub");
const args = process.argv.slice(2).join(" ");
fs.appendFileSync(path.join(dir, "calls.log"), args + "\\n");
if (args === "--version") {
  process.stdout.write("10.21.0\\n");
  process.exit(0);
}
const name =
  args === "audit --json --only=null --no-production --no-dev --optional"
    ? "full"
    : args === "audit --json --only=prod --production --no-dev --optional"
      ? "prod"
      : "unexpected";
process.stdout.write(fs.readFileSync(path.join(dir, name + ".out"), "utf8"));
process.exit(Number(fs.readFileSync(path.join(dir, name + ".exit"), "utf8")));
`;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Scenario {
  full: [number, string];
  prod?: [number, string];
  policy?: unknown;
}

function utcSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

function currentPolicy(): unknown {
  const created = Date.now() - 60 * 60 * 1000;
  return policy([
    exception({
      createdAt: utcSeconds(created),
      expiresAt: utcSeconds(created + 14 * 24 * 60 * 60 * 1000),
    }),
  ]);
}

function runCli(s: Scenario): { status: number | null; stdout: string; calls: string } {
  const root = mkdtempSync(join(tmpdir(), "audit-gate-e2e-"));
  dirs.push(root);
  cpSync(join(TOOL, "cli.ts"), join(root, "tools", "audit-gate", "cli.ts"));
  cpSync(join(TOOL, "src"), join(root, "tools", "audit-gate", "src"), {
    recursive: true,
    filter: (p) => !p.endsWith(".test.ts"),
  });
  writeFileSync(
    join(root, "tools", "audit-gate", "audit-exceptions.json"),
    JSON.stringify(s.policy ?? currentPolicy()),
  );
  writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", ...ROOT_MANIFEST }));
  const stub = join(root, "stub");
  const bin = join(root, "bin");
  mkdirSync(stub);
  mkdirSync(bin);
  const files: Record<string, string> = {
    "full.out": s.full[1],
    "full.exit": String(s.full[0]),
    "prod.out": (s.prod ?? [0, JSON.stringify(report([]))])[1],
    "prod.exit": String((s.prod ?? [0, ""])[0]),
    "unexpected.out": "",
    "unexpected.exit": "97",
    "calls.log": "",
  };
  for (const [name, content] of Object.entries(files)) writeFileSync(join(stub, name), content);
  writeFileSync(join(bin, "pnpm"), STUB);
  chmodSync(join(bin, "pnpm"), 0o755);
  // Run the package script's command line itself, so the test breaks if the script changes.
  const [command, ...args] = (SCRIPT ?? "").split(" ");
  expect(command).toBe("node");
  const r = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: [bin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter),
    },
  });
  return {
    status: r.status,
    stdout: r.stdout + r.stderr,
    calls: readFileSync(join(stub, "calls.log"), "utf8"),
  };
}

test.skipIf(process.platform === "win32")(
  "raw audit fails on the known advisory while the gate passes and logs the accepted risk",
  () => {
    const raw = JSON.stringify(report([advisory()]), null, 2);
    const r = runCli({ full: [1, raw] });
    expect(r.status).toBe(0);
    expect(r.calls).toBe(
      "--version\naudit --json --only=null --no-production --no-dev --optional\naudit --json --only=prod --production --no-dev --optional\n",
    );
    expect(r.stdout).toContain(raw);
    expect(r.stdout).toContain(
      "ACCEPTED RISK (not fixed): high GHSA-fc5q-39xc-vjpf picomatch@4.0.7 via .>vitest>picomatch",
    );
    expect(r.stdout).toContain("tracking https://github.com/shaangill025/CiteSpark/issues/21");
  },
);

test.skipIf(process.platform === "win32")(
  "the CLI exits non-zero on every fail-closed path",
  () => {
    const known = JSON.stringify(report([advisory()]));
    const other = JSON.stringify(report([advisory(), syntheticAdvisory(9020, "critical")]));
    const created = Date.now() - 15 * 24 * 60 * 60 * 1000;
    const expired = policy([
      exception({
        createdAt: utcSeconds(created),
        expiresAt: utcSeconds(created + 14 * 24 * 60 * 60 * 1000),
      }),
    ]);
    const cases: [Scenario, string][] = [
      [{ full: [1, other] }, "blocked: critical GHSA-2222-3333-4444 synthetic-9020@1.0.0"],
      [{ full: [0, known] }, "pnpm audit exited 0, expected 1"],
      [{ full: [2, known] }, "pnpm audit exited 2, expected 1"],
      [
        { full: [1, "ERR_PNPM_AUDIT_BAD_RESPONSE synthetic"] },
        "full report rejected (fail closed): pnpm output is not JSON",
      ],
      [{ full: [1, known], prod: [1, known] }, "(the production-only audit reports this advisory)"],
      [{ full: [1, known], policy: expired }, "policy: exception GHSA-fc5q-39xc-vjpf expired at"],
    ];
    for (const [scenario, message] of cases) {
      const r = runCli(scenario);
      expect(r.status).toBe(1);
      expect(r.stdout).toContain(message);
      expect(r.stdout).toContain("Dependency audit gate FAILED.");
    }
  },
);
