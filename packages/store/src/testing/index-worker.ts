// Index generation worker: runs one build or switch against a store file, optionally holding at a fault
// point so the test process can kill it (SIGKILL on POSIX, TerminateProcess on Windows).
// Usage: node index-worker.ts <db> build <trigram 0|1> [<point> <marker>]
//        node index-worker.ts <db> activate <generation> [<point> <marker>]
import Database from "better-sqlite3";
import { writeFileSync, writeSync } from "node:fs";
import { IndexStore, migrate, type IndexFaultPoint } from "../index.ts";

const [dbPath, op, arg, crashPoint, marker] = process.argv.slice(2);

const db = new Database(dbPath!);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = FULL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");
migrate(db);

// Block synchronously at the fault point, inside the open transaction where it applies.
const hold = (point: IndexFaultPoint): void => {
  if (point !== crashPoint) return;
  writeFileSync(marker!, point);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
};

const index = new IndexStore(db);
if (op === "build") {
  const g = index.build({ trigram: arg === "1", batchSize: 4, onFaultPoint: hold });
  writeSync(1, `${g}\n`);
} else if (op === "activate") {
  index.activate(Number(arg), { onFaultPoint: hold });
  writeSync(1, `${index.active()}\n`);
} else {
  throw new Error(`unknown op ${op}`);
}
db.close();
