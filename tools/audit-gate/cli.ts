// CI entry point for the dependency audit gate (`pnpm audit-gate`). It always runs the full `pnpm audit --json`
// and prints its report unchanged; see docs/security/dependency-audit-exceptions.md. Takes no arguments and
// reads no environment overrides: the commands, policy path and clock are fixed.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runGate } from "./src/run.ts";

const root = join(import.meta.dirname, "..", "..");

process.exitCode = runGate({
  runPnpm: (args) => {
    // Fixed argument list and no shell, so nothing can be injected into the command line.
    const r = spawnSync("pnpm", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      shell: false,
    });
    return {
      status: r.error === undefined ? r.status : null,
      stdout: r.stdout ?? "",
      stderr: `${r.stderr ?? ""}${r.error === undefined ? "" : `failed to run pnpm: ${r.error.message}`}`,
    };
  },
  readPolicy: () => readFileSync(join(import.meta.dirname, "audit-exceptions.json"), "utf8"),
  readManifest: () => readFileSync(join(root, "package.json"), "utf8"),
  now: () => new Date(),
  log: (line) => console.log(line),
});
