import { parentPort, workerData } from "node:worker_threads";
import type { ExtractionInput, WorkerReply } from "../extract-protocol.ts";

/**
 * Test-only fault-injection worker for `ExtractionPool` lifecycle tests. The mode is carried in the
 * input's `contentType`. Never used by production code.
 */
const { contentType: mode } = workerData as ExtractionInput;
const reply = (text: string): WorkerReply => ({
  kind: "page",
  page: { title: null, canonicalUrl: null, text, contentHash: text, extractionMethod: "fault" },
});

if (mode === "fault/startup") throw new Error("synthetic startup failure");
if (mode === "fault/exit") process.exit(3);
if (mode === "fault/twice") {
  parentPort?.postMessage(reply("first"));
  parentPort?.postMessage(reply("second"));
}
if (mode === "fault/hang") setInterval(() => undefined, 1000);
if (mode === "fault/late") setTimeout(() => parentPort?.postMessage(reply("late")), 2000);
