// T01 capture replay (release-blocking, every CI OS): kill a capture process before, during, and after
// a page commit on the first, a middle, and the last page, then resume. Committed records must all be
// recovered with zero duplicate canonical identities and no cursor advanced past uncommitted data.
import Database from "better-sqlite3";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { FaultPoint } from "./index.ts";
import {
  PAGE_COUNT,
  allPages,
  cursorFor,
  expectedDistinctPosts,
  expectedDistinctVersions,
  platformIdsOfFirstPages,
} from "./testing/synthetic-feed.ts";

const WORKER = join(import.meta.dirname, "testing", "t01-worker.ts");
const T0 = 1_800_000_000_000;
const LEASE_TTL_MS = 60_000;
const EXIT_LEASE_HELD = 3;
const WORKER_TIMEOUT_MS = 30_000;

interface Outcome {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  /** Commit status per page, in order. */
  statuses: string[];
  killedAtFaultPoint: boolean;
}

interface Crash {
  page: number;
  point: FaultPoint;
  marker: string;
}

function runWorker(
  db: string,
  owner: string,
  now: number,
  passId: string,
  startPage: number,
  crash?: Crash,
): Promise<Outcome> {
  const args = ["--no-warnings", WORKER, db, owner, String(now), passId, String(startPage)];
  if (crash) args.push(String(crash.page), crash.point, crash.marker);
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    let killedAtFaultPoint = false;
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
          // SIGKILL; Node maps it to TerminateProcess on Windows.
          child.kill("SIGKILL");
        }
      }, 10);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      const statuses = stdout.split(/\r?\n/).filter(Boolean);
      resolve({ code, signal, stderr, statuses, killedAtFaultPoint });
    });
  });
}

function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "citspark-t01-"));
  return fn(dir).finally(() =>
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  );
}

interface Snapshot {
  state: string;
  cursor: string | null;
  sources: number;
  versions: number;
  memberships: number;
  observations: number;
  pages: number;
  duplicateIdentities: number;
  orphanObservations: number;
  platformIds: Set<string>;
  pagesByPass: Map<string, { seq: number; newRecords: number }[]>;
}

function snapshot(path: string): Snapshot {
  // Read-write open so a crashed WAL can be recovered; nothing is written.
  const db = new Database(path);
  try {
    const n = (sql: string): number => (db.prepare(sql).get() as { n: number }).n;
    const job = db.prepare("SELECT state, cursor FROM job").get() as {
      state: string;
      cursor: string | null;
    };
    const pagesByPass = new Map<string, { seq: number; newRecords: number }[]>();
    for (const r of db
      .prepare("SELECT pass_id, seq, new_records FROM capture_page ORDER BY pass_id, seq")
      .all() as { pass_id: string; seq: number; new_records: number }[]) {
      const list = pagesByPass.get(r.pass_id) ?? [];
      list.push({ seq: r.seq, newRecords: r.new_records });
      pagesByPass.set(r.pass_id, list);
    }
    return {
      state: job.state,
      cursor: job.cursor,
      sources: n("SELECT COUNT(*) n FROM source"),
      versions: n("SELECT COUNT(*) n FROM source_version"),
      memberships: n("SELECT COUNT(*) n FROM membership"),
      observations: n("SELECT COUNT(*) n FROM observation"),
      pages: n("SELECT COUNT(*) n FROM capture_page"),
      duplicateIdentities: n(
        "SELECT COUNT(*) n FROM (SELECT 1 FROM source GROUP BY source_type, platform_id HAVING COUNT(*) > 1)",
      ),
      orphanObservations: n(
        `SELECT COUNT(*) n FROM observation o WHERE o.capture_page_id IS NULL
           OR NOT EXISTS (SELECT 1 FROM capture_page p WHERE p.id = o.capture_page_id AND p.job_id = o.job_id)`,
      ),
      platformIds: new Set(
        (db.prepare("SELECT platform_id FROM source").all() as { platform_id: string }[]).map(
          (r) => r.platform_id,
        ),
      ),
      pagesByPass,
    };
  } finally {
    db.close();
  }
}

const versionsOfFirstPages = (n: number): number =>
  new Set(
    allPages("any")
      .slice(0, n)
      .flatMap((p) => p.records.map((r) => `${r.platformId}\u0000${r.text}`)),
  ).size;

function expectCrashState(s: Snapshot, committed: number): void {
  expect(s.pages, "only durable pages are recorded").toBe(committed);
  expect(s.platformIds, "exactly the committed pages are present").toEqual(
    platformIdsOfFirstPages(committed),
  );
  expect(s.versions).toBe(versionsOfFirstPages(committed));
  expect(s.observations).toBe(versionsOfFirstPages(committed));
  expect(s.orphanObservations, "no records from an uncommitted page").toBe(0);
  expect(s.duplicateIdentities).toBe(0);
  const expectedCursor = committed === PAGE_COUNT ? null : cursorFor("pass-1", committed);
  expect(s.cursor, "cursor never advanced past uncommitted data").toBe(expectedCursor);
}

function expectComplete(s: Snapshot): void {
  expect(s.state).toBe("complete");
  expect(s.cursor).toBeNull();
  expect(s.sources, "one canonical source per platform ID").toBe(expectedDistinctPosts());
  expect(s.versions, "one version per distinct observed text").toBe(expectedDistinctVersions());
  expect(s.memberships, "one membership per source in the collection").toBe(
    expectedDistinctPosts(),
  );
  expect(s.observations, "one observation per version for the job").toBe(
    expectedDistinctVersions(),
  );
  expect(s.duplicateIdentities).toBe(0);
  expect(s.orphanObservations).toBe(0);
}

const POINTS: FaultPoint[] = ["mid-page", "before-commit", "after-commit"];
const CRASH_PAGES = [0, Math.floor(PAGE_COUNT / 2), PAGE_COUNT - 1];

describe("T01 capture replay", () => {
  for (const point of POINTS) {
    for (const page of CRASH_PAGES) {
      for (const resume of ["fresh pass", "same pass"] as const) {
        it(`kill ${point} on page ${page}, resume with ${resume}`, async () => {
          await withTempDir(async (dir) => {
            const db = join(dir, "library.db");
            const crash: Crash = { page, point, marker: join(dir, "fault-point") };
            const crashed = await runWorker(db, "owner-a", T0, "pass-1", 0, crash);
            expect(crashed.killedAtFaultPoint, crashed.stderr).toBe(true);
            expect(crashed.code).not.toBe(0);

            const committed = point === "after-commit" ? page + 1 : page;
            const afterCrash = snapshot(db);
            expectCrashState(afterCrash, committed);

            const complete = committed === PAGE_COUNT;
            if (complete) {
              expect(afterCrash.state, "the recognized end committed with the last page").toBe(
                "complete",
              );
            } else {
              const blocked = await runWorker(db, "owner-b", T0 + 1_000, "pass-2", 0);
              expect(blocked.code, "an unexpired lease blocks a second owner").toBe(
                EXIT_LEASE_HELD,
              );
            }

            // Fresh pass: the desktop restarted, so capture scrolls from the top with new cursors
            // (ADR 0005). Same pass: the extension re-sends the unacknowledged page.
            const resumeAt = T0 + LEASE_TTL_MS * 2;
            const resumed =
              resume === "fresh pass"
                ? await runWorker(db, "owner-b", resumeAt, "pass-2", 0)
                : await runWorker(db, "owner-b", resumeAt, "pass-1", page);
            if (complete && resume === "fresh pass") {
              // A finished job starts no new pass; nothing changes.
              expect(resumed.code).not.toBe(0);
              expect(resumed.statuses).toEqual([]);
              expect(snapshot(db)).toEqual(afterCrash);
              return;
            }
            expect(resumed.code, resumed.stderr).toBe(0);

            const done = snapshot(db);
            expectComplete(done);

            if (resume === "fresh pass") {
              const pass2 = done.pagesByPass.get("pass-2") ?? [];
              expect(pass2).toHaveLength(PAGE_COUNT);
              expect(
                pass2.filter((p) => p.seq < committed).every((p) => p.newRecords === 0),
                "re-read committed pages are no-ops while catching up",
              ).toBe(true);
              expect(pass2[committed]!.newRecords).toBeGreaterThan(0);
              expect(done.pages).toBe(committed + PAGE_COUNT);
            } else {
              expect(done.pagesByPass.get("pass-1")).toHaveLength(PAGE_COUNT);
              expect(done.pages).toBe(PAGE_COUNT);
              expect(resumed.statuses[0], "the re-sent page").toBe(
                point === "after-commit" ? "replayed" : "committed",
              );
              expect(resumed.statuses.slice(1).every((x) => x === "committed")).toBe(true);
            }
          });
        }, 120_000);
      }
    }
  }
});
