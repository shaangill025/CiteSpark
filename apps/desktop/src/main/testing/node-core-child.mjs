// Test fixture: runs the real core host in a plain Node child process, the way the Electron utility process
// runs it, with optional injected faults. Never shipped.
import { runCoreHost } from "@citspark/core/host";

const [mode, dataDir] = process.argv.slice(2);

if (mode === "crash-on-start") {
  process.exit(3);
} else if (mode === "never-ready") {
  setInterval(() => undefined, 1000);
} else {
  const port = {
    onMessage: (cb) =>
      process.on("message", (msg) => {
        if (mode === "hang-on-shutdown" && msg?.type === "core.shutdown") return;
        cb(msg);
      }),
    post: (data) => process.send?.(data),
  };
  if (mode === "hang-on-shutdown") setInterval(() => undefined, 1000);
  const host = runCoreHost(port, { dataDir, coreVersion: "test" });
  void host.stopped.then(() => process.disconnect?.());
}
