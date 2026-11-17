// Child for the xarchive path tests: reads one path and prints the outcome on one line, so a source
// that would block on open (a FIFO) fails the test by timeout instead of hanging the runner.
import { readXArchiveFile } from "../xarchive.ts";

const path = process.argv[2] ?? "";
try {
  const text = readXArchiveFile(path);
  console.log(`read ${text.length}`);
} catch (e) {
  console.log(`threw ${(e as Error).constructor.name}`);
}
