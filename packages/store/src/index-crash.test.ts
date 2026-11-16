// RET-03 crash atomicity: kill a process before, during, and after an index generation switch, and during a
// build. The store must always show exactly one consistent active generation, searches must return that
// generation's results, and rollback must restore the previous generation's results.
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { IndexStore, migrate, type IndexFaultPoint, type SearchHit } from "./index.ts";
import { seedCorpus } from "./testing/synthetic-corpus.ts";

const WORKER = join(import.meta.dirname, "testing", "index-worker.ts");
const WORKER_TIMEOUT_MS = 30_000;
const QUERIES = ["doc3", "citation evidence", "library", "doc14"];

interface Outcome {
  code: number | null;
  stdout: string;
  stderr: string;
  killedAtFaultPoint: boolean;
}

function runWorker(db: string, args: string[], crash?: { point: IndexFaultPoint; marker: string }) {
  const argv = ["--no-warnings", WORKER, db, ...args];
  if (crash) argv.push(crash.point, crash.marker);
  return new Promise<Outcome>((resolve, reject) => {
    const child = spawn(process.execPath, argv, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let killedAtFaultPoint = false;
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker timed out: ${stderr}`));
    }, WORKER_TIMEOUT_MS);
    const poll =
      crash &&
      setInterval(() => {
        if (!killedAtFaultPoint && existsSync(crash.marker)) {
          killedAtFaultPoint = true;
          child.kill("SIGKILL"); // TerminateProcess on Windows
        }
      }, 10);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      resolve({ code, stdout, stderr, killedAtFaultPoint });
    });
  });
}

function open(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  return db;
}

/** Store with generation 1 active and generation 2 (smaller chunks) built and ready. */
function setup(path: string): SearchHit[][] {
  const db = open(path);
  db.pragma("journal_mode = WAL");
  migrate(db);
  seedCorpus(db, 30);
  const index = new IndexStore(db);
  index.activate(index.build());
  const results = QUERIES.map((q) => index.search(q, { limit: 50 }));
  index.build({ chunker: { maxChars: 120, overlapChars: 20 } });
  db.close();
  return results;
}

interface State {
  active: number;
  previous: number | null;
  states: Record<number, string>;
  results: SearchHit[][];
}

function inspect(path: string): State {
  const db = open(path);
  try {
    expect(db.pragma("integrity_check", { simple: true })).toBe("ok");
    const index = new IndexStore(db);
    const states = Object.fromEntries(index.generations().map((g) => [g.generation, g.state]));
    const active = index.active();
    // Exactly one generation is marked active, and it is the one searches read.
    expect(Object.entries(states).filter(([, s]) => s === "active")).toEqual([
      [String(active), "active"],
    ]);
    index.verify(active);
    const results = QUERIES.map((q) => index.search(q, { limit: 50 }));
    for (const hits of results) for (const h of hits) expect(h.generation).toBe(active);
    return { active, previous: index.previous(), states, results };
  } finally {
    db.close();
  }
}

async function withStore(fn: (path: string, dir: string, before: SearchHit[][]) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "citspark-index-"));
  try {
    const path = join(dir, "library.db");
    await fn(path, dir, setup(path));
  } finally {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

describe("index generation switch under crash (RET-03)", () => {
  it.each(["before-switch", "mid-switch"] as const)(
    "a kill at %s leaves the previous generation active and serving",
    (point) =>
      withStore(async (path, dir, before) => {
        const run = await runWorker(path, ["activate", "2"], { point, marker: join(dir, "m") });
        expect(run.killedAtFaultPoint, run.stderr).toBe(true);
        const s = inspect(path);
        expect(s).toMatchObject({ active: 1, previous: null, states: { 1: "active", 2: "ready" } });
        expect(s.results).toEqual(before);

        const retry = await runWorker(path, ["activate", "2"]);
        expect(retry.code, retry.stderr).toBe(0);
        expect(inspect(path)).toMatchObject({
          active: 2,
          previous: 1,
          states: { 1: "retired", 2: "active" },
        });
      }),
    WORKER_TIMEOUT_MS * 2,
  );

  it(
    "a kill after the switch commits keeps the new generation, and rollback restores the old results",
    () =>
      withStore(async (path, dir, before) => {
        const run = await runWorker(path, ["activate", "2"], {
          point: "after-switch",
          marker: join(dir, "m"),
        });
        expect(run.killedAtFaultPoint, run.stderr).toBe(true);
        const s = inspect(path);
        expect(s).toMatchObject({ active: 2, previous: 1, states: { 1: "retired", 2: "active" } });
        expect(s.results).not.toEqual(before);
        const retry = await runWorker(path, ["activate", "2"]);
        expect(retry.code, retry.stderr).toBe(0); // retrying a committed switch is a no-op
        expect(inspect(path)).toMatchObject({ active: 2, previous: 1 });

        const db = open(path);
        new IndexStore(db).rollback();
        db.close();
        const back = inspect(path);
        expect(back).toMatchObject({ active: 1, previous: 2 });
        expect(back.results).toEqual(before);
      }),
    WORKER_TIMEOUT_MS * 2,
  );

  it(
    "a kill mid-build leaves the active generation untouched and recover() clears the partial build",
    () =>
      withStore(async (path, dir, before) => {
        const run = await runWorker(path, ["build", "1"], {
          point: "mid-build",
          marker: join(dir, "m"),
        });
        expect(run.killedAtFaultPoint, run.stderr).toBe(true);
        const s = inspect(path);
        expect(s).toMatchObject({ active: 1, states: { 3: "building" } });
        expect(s.results).toEqual(before);

        const db = open(path);
        const partial = db.prepare("SELECT COUNT(*) FROM chunk WHERE index_generation = 3").pluck();
        expect(partial.get()).toBeGreaterThan(0); // the first batch had committed
        const index = new IndexStore(db);
        expect(index.recover()).toEqual([3]);
        expect(partial.get()).toBe(0);
        expect(index.generation(3).state).toBe("failed");
        db.close();

        const rebuild = await runWorker(path, ["build", "1"]);
        expect(rebuild.code, rebuild.stderr).toBe(0);
        expect(rebuild.stdout.trim()).toBe("4");
        expect(inspect(path).results).toEqual(before);
      }),
    WORKER_TIMEOUT_MS * 2,
  );
});
