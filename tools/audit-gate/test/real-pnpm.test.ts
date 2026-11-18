// End-to-end with the real pnpm on PATH (CI installs the pinned pnpm 10.21.0) against a local, clearly
// synthetic audit registry. The registry records which root dependency groups pnpm actually put in each audit
// request, so these tests check the request scope pnpm builds under inherited .npmrc, environment and
// pnpm-workspace.yaml settings, not only the command line the gate passes. Only the reviewed picomatch
// identifiers are real; the synthetic-* packages and their advisories are invented.
import { spawn } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { advisory, exception, policy, ROOT_MANIFEST, syntheticAdvisory } from "./fixtures.ts";

const TOOL = join(import.meta.dirname, "..");
const REPO = join(TOOL, "..", "..");
const REPO_MANIFEST = JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as {
  packageManager: string;
  scripts: Record<string, string>;
};

type Group = "dev" | "dep" | "opt";
type Scope = Record<Group, boolean>;

interface RegistryBehaviour {
  // Root groups whose synthetic package carries a high advisory when pnpm includes it in the request.
  vulnerable: Group[];
}

const DEP = syntheticAdvisory(9101, "high", {
  module_name: "synthetic-dep",
  github_advisory_id: "GHSA-2222-3333-4444",
  cves: ["CVE-2026-999991"],
  findings: [{ version: "1.0.0", paths: [".>synthetic-dep"] }],
});
const OPT = syntheticAdvisory(9102, "high", {
  module_name: "synthetic-opt",
  github_advisory_id: "GHSA-3333-4444-5555",
  cves: ["CVE-2026-999992"],
  findings: [{ version: "1.0.0", paths: [".>synthetic-opt"] }],
});

let behaviour: RegistryBehaviour = { vulnerable: [] };
let requests: Scope[] = [];
let server: Server;
let registry = "";

function dependencyNames(tree: unknown, into: Set<string>): Set<string> {
  if (Array.isArray(tree)) for (const v of tree) dependencyNames(v, into);
  else if (typeof tree === "object" && tree !== null) {
    const deps = (tree as Record<string, unknown>).dependencies;
    if (typeof deps === "object" && deps !== null) for (const k of Object.keys(deps)) into.add(k);
    for (const v of Object.values(tree)) dependencyNames(v, into);
  }
  return into;
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")));
    req.on("end", () => {
      const names = dependencyNames(JSON.parse(body) as unknown, new Set());
      const scope: Scope = {
        dev: names.has("vitest"),
        dep: names.has("synthetic-dep"),
        opt: names.has("synthetic-opt"),
      };
      requests.push(scope);
      const advisories = [];
      if (scope.dev) advisories.push(advisory());
      if (scope.dep && behaviour.vulnerable.includes("dep")) advisories.push(DEP);
      if (scope.opt && behaviour.vulnerable.includes("opt")) advisories.push(OPT);
      const high = advisories.reduce(
        (n, a) => n + a.findings.reduce((m, f) => m + f.paths.length, 0),
        0,
      );
      const payload = JSON.stringify({
        actions: [],
        advisories: Object.fromEntries(advisories.map((a) => [String(a.id), a])),
        muted: [],
        metadata: {
          vulnerabilities: { info: 0, low: 0, moderate: 0, high, critical: 0 },
          dependencies: names.size,
          devDependencies: 0,
          optionalDependencies: 0,
          totalDependencies: names.size,
        },
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(payload);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  registry = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

const LOCKFILE = `lockfileVersion: '9.0'
settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false
importers:
  .:
    dependencies:
      synthetic-dep:
        specifier: 1.0.0
        version: 1.0.0
    optionalDependencies:
      synthetic-opt:
        specifier: 1.0.0
        version: 1.0.0
    devDependencies:
      vitest:
        specifier: ^4.0.0
        version: 4.1.12
      typescript-eslint:
        specifier: 8.46.4
        version: 8.46.4
packages:
  synthetic-dep@1.0.0:
    resolution: {integrity: synthetic}
  synthetic-opt@1.0.0:
    resolution: {integrity: synthetic}
  vitest@4.1.12:
    resolution: {integrity: synthetic}
  typescript-eslint@8.46.4:
    resolution: {integrity: synthetic}
snapshots:
  synthetic-dep@1.0.0: {}
  synthetic-opt@1.0.0: {}
  vitest@4.1.12: {}
  typescript-eslint@8.46.4: {}
`;

interface Inherited {
  npmrc?: string;
  workspace?: string;
  env?: Record<string, string>;
}

function utcSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(".000Z", "Z");
}

async function runGate(
  inherited: Inherited,
  vulnerable: Group[],
): Promise<{ status: number | null; stdout: string; scopes: Scope[] }> {
  const root = mkdtempSync(join(tmpdir(), "audit-gate-real-pnpm-"));
  try {
    cpSync(join(TOOL, "cli.ts"), join(root, "tools", "audit-gate", "cli.ts"));
    cpSync(join(TOOL, "src"), join(root, "tools", "audit-gate", "src"), {
      recursive: true,
      filter: (p) => !p.endsWith(".test.ts"),
    });
    const created = Date.now() - 60 * 60 * 1000;
    writeFileSync(
      join(root, "tools", "audit-gate", "audit-exceptions.json"),
      JSON.stringify(
        policy([
          exception({
            createdAt: utcSeconds(created),
            expiresAt: utcSeconds(created + 14 * 24 * 60 * 60 * 1000),
          }),
        ]),
      ),
    );
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        name: "synthetic-audit-scope",
        private: true,
        type: "module",
        packageManager: REPO_MANIFEST.packageManager,
        dependencies: { "synthetic-dep": "1.0.0" },
        optionalDependencies: { "synthetic-opt": "1.0.0" },
        devDependencies: ROOT_MANIFEST.devDependencies,
      }),
    );
    writeFileSync(join(root, "pnpm-workspace.yaml"), `packages: []\n${inherited.workspace ?? ""}`);
    writeFileSync(
      join(root, ".npmrc"),
      `registry=${registry}\nfetch-retries=0\n${inherited.npmrc ?? ""}`,
    );
    writeFileSync(join(root, "user.npmrc"), "");
    writeFileSync(join(root, "pnpm-lock.yaml"), LOCKFILE);
    // Isolate from the developer's or the test runner's own pnpm settings, then add the inherited ones.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) {
      if (v !== undefined && !/^(npm|pnpm)_config_/i.test(k)) env[k] = v;
    }
    Object.assign(
      env,
      {
        npm_config_userconfig: join(root, "user.npmrc"),
        npm_config_update_notifier: "false",
      },
      inherited.env,
    );
    behaviour = { vulnerable };
    requests = [];
    const [command, ...args] = (REPO_MANIFEST.scripts["audit-gate"] ?? "").split(" ");
    expect(command).toBe("node");
    const child = spawn(process.execPath, args, { cwd: root, env });
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    child.stderr.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
    const status = await new Promise<number | null>((resolve) => child.on("close", resolve));
    return { status, stdout, scopes: requests };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const posix = test.skipIf(process.platform === "win32");

posix(
  "inherited dev=true cannot hide a production high that only the production audit sees",
  { timeout: 60_000 },
  async () => {
    for (const inherited of [{ npmrc: "dev=true\n" }, { env: { npm_config_dev: "true" } }]) {
      const r = await runGate(inherited, ["dep"]);
      expect(r.stdout).toContain(
        "blocked: high GHSA-2222-3333-4444 synthetic-dep@1.0.0 via .>synthetic-dep",
      );
      expect(r.stdout).toContain("Dependency audit gate FAILED.");
      expect(r.status).toBe(1);
    }
  },
);

posix(
  "control: with clean production dependencies the gate passes only the reviewed development findings",
  { timeout: 60_000 },
  async () => {
    const r = await runGate({}, []);
    expect(r.stdout).toContain(
      "ACCEPTED RISK (not fixed): high GHSA-fc5q-39xc-vjpf picomatch@4.0.7 via .>vitest>picomatch",
    );
    expect(r.stdout).toContain("Dependency audit gate PASSED only under a temporary exception");
    expect(r.status).toBe(0);
  },
);
