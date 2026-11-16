// T01 capture worker: commits the synthetic feed into a store file, optionally holding at a fault
// point so the test process can kill it (SIGKILL on POSIX, TerminateProcess on Windows).
// Usage: node t01-worker.ts <db> <owner> <nowMs> <passId> <startPage> [<crashPage> <point> <marker>]
import Database from "better-sqlite3";
import { writeFileSync, writeSync } from "node:fs";
import { CaptureStore, JobStore, UnknownJobError, migrate, type FaultPoint } from "../index.ts";
import { ACCOUNT, COLLECTION, pageAt } from "./synthetic-feed.ts";

const JOB_ID = "job-1";
const LEASE_TTL_MS = 60_000;
const EXIT_LEASE_HELD = 3;

const [dbPath, owner, nowArg, passId, startArg, crashArg, crashPoint, marker] =
  process.argv.slice(2);
const now = Number(nowArg);
const crashPage = crashArg === undefined ? -1 : Number(crashArg);

const db = new Database(dbPath!);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
migrate(db);
const jobs = new JobStore(db);
try {
  jobs.get(JOB_ID);
} catch (e) {
  if (!(e instanceof UnknownJobError)) throw e;
  jobs.create({ id: JOB_ID, kind: "capture", accountId: ACCOUNT, collectionId: COLLECTION });
}
// A completed job holds no lease but still acknowledges re-sent pages.
const complete = jobs.get(JOB_ID).state === "complete";
if (!complete && !jobs.acquire(JOB_ID, owner!, now, LEASE_TTL_MS)) process.exit(EXIT_LEASE_HELD);

// Block synchronously at the fault point, inside the open transaction where it applies.
const hold = (point: FaultPoint): void => {
  if (point !== crashPoint) return;
  writeFileSync(marker!, point);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const capture = new CaptureStore(db, jobs);
for (let p = Number(startArg); ; p++) {
  const r = capture.commitPage(
    JOB_ID,
    owner!,
    now,
    pageAt(passId!, p),
    p === crashPage ? { onFaultPoint: hold } : {},
  );
  // One status line per page for the test; written synchronously so it survives a later kill.
  writeSync(1, `${r.status}\n`);
  if (r.ended) break;
}
db.close();
