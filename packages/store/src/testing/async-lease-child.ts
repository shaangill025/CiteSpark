// Child for the withLease strict-mode test: refused async work must not leave an unhandled
// rejection. Run with --unhandled-rejections=strict; prints one line per case, then "survived".
import Database from "better-sqlite3";
import { runInNewContext } from "node:vm";
import { JobStore, migrate } from "../index.ts";

const db = new Database(":memory:");
migrate(db);
const jobs = new JobStore(db);
jobs.create({ id: "j", kind: "capture", accountId: "a", collectionId: "c" });
const lease = jobs.acquire("j", "A", 0, 1000)!;
const untyped = (fn: unknown) => fn as () => void;

let invoked = false;
const cases: [string, unknown][] = [
  [
    "async function",
    async () => {
      invoked = true;
      throw new Error("late rejection");
    },
  ],
  // Bound functions are not recognized as async, so they run; their rejection is still handled.
  [
    "bound async function",
    async function () {
      throw new Error("bound rejection");
    }.bind(null),
  ],
  ["returned rejected promise", () => Promise.reject(new Error("returned rejection"))],
  ["other-realm rejected promise", () => runInNewContext("Promise.reject(new Error('realm'))")],
];
for (const [name, fn] of cases) {
  try {
    jobs.withLease("j", lease, 1, untyped(fn));
    console.log(`${name}: accepted`);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    console.log(`${name}: ${name === "async function" && !invoked ? "not invoked" : "refused"}`);
  }
}
await new Promise((resolve) => setTimeout(resolve, 50));
console.log("survived");
