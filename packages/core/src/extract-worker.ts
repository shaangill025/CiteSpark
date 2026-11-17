import { parentPort, workerData } from "node:worker_threads";
import { decodeBody } from "./decode.ts";
import type { ExtractionInput, WorkerReply } from "./extract-protocol.ts";
import { ExtractionLimitError, extractPage } from "./links.ts";

/**
 * Worker entry for `extract-isolated.ts`: decodes and parses one untrusted body, posts one reply and
 * returns. Any other failure is left uncaught so the parent sees it as a worker error (a defect).
 */
function run(input: ExtractionInput): WorkerReply {
  const decoded = decodeBody(input.body, input.contentType, input.charset);
  if (!decoded.ok) return { kind: "gap", reason: decoded.reason, detail: decoded.detail };
  try {
    return { kind: "page", page: extractPage(decoded.text, input.contentType, input.finalUrl) };
  } catch (error) {
    if (!(error instanceof ExtractionLimitError)) throw error;
    return { kind: "gap", reason: "extraction_limit", detail: error.message };
  }
}

if (parentPort === null) throw new Error("extract-worker must run as a worker thread");
parentPort.postMessage(run(workerData as ExtractionInput));
