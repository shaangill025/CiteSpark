import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const core = fileURLToPath(new URL("../", import.meta.url));

// Runs in a plain Node process against the compiled package with type stripping disabled, so the
// worker entry that runs is the emitted `extract-worker.js`, not the TypeScript source.
const PROBE = `
const { defaultExtractionPool } = await import(${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)});
const page = (html) => ({ body: new TextEncoder().encode(html), contentType: "text/html", charset: null, finalUrl: "https://example.test/" });
const ok = await defaultExtractionPool.extract(page("<title>T</title><p>compiled</p>"), performance.now() + 30000);
const adversarial = "<span>".repeat(6000) + "</button>".repeat(400000);
let ticks = 0;
const heartbeat = setInterval(() => ticks++, 20);
const started = performance.now();
const late = await defaultExtractionPool.extract(page(adversarial), performance.now() + 1000);
const elapsed = Math.round(performance.now() - started);
clearInterval(heartbeat);
console.log(JSON.stringify({ ok, late, elapsed, ticks }));
`;

describe("compiled extraction worker", () => {
  it("runs the emitted worker entry and terminates it at the deadline", () => {
    const build = spawnSync(
      process.execPath,
      [`${root}node_modules/typescript/bin/tsc`, "--build", `${core}tsconfig.json`],
      { encoding: "utf8", timeout: 120_000 },
    );
    expect(build.status, build.stdout + build.stderr).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "citspark-compiled-"));
    const probe = join(dir, "probe.mjs");
    writeFileSync(probe, PROBE);
    const run = spawnSync(process.execPath, ["--no-experimental-strip-types", probe], {
      encoding: "utf8",
      timeout: 60_000,
    });
    rmSync(dir, { recursive: true, force: true });
    expect(run.status, run.stderr).toBe(0);
    const out = JSON.parse(run.stdout) as {
      ok: unknown;
      late: unknown;
      elapsed: number;
      ticks: number;
    };
    expect(out.ok).toMatchObject({ kind: "page", page: { title: "T", text: "compiled" } });
    expect(out.late).toEqual({ kind: "deadline" });
    expect(out.elapsed).toBeLessThan(1000 + 1500);
    expect(out.ticks).toBeGreaterThan(10);
  }, 200_000);
});
