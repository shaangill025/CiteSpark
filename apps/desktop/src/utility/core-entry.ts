import { runCoreHost, type HostPort } from "@citspark/core/host";

// Entry of the Electron utility process. Everything it runs is the plain-Node core (ADR 0001); the only
// Electron-specific part is `process.parentPort`, a global this process gets from Electron.

interface ParentPort {
  on(event: "message", listener: (e: { data: unknown }) => void): void;
  postMessage(message: unknown): void;
}

const parentPort = (process as unknown as { parentPort?: ParentPort }).parentPort;
if (!parentPort) {
  process.exitCode = 2;
  throw new Error("core.cjs must run in an Electron utility process");
}

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

const port: HostPort = {
  onMessage: (listener) => parentPort.on("message", (e) => listener(e.data)),
  post: (data) => parentPort.postMessage(data),
};

const host = runCoreHost(port, {
  dataDir: arg("data-dir") ?? "",
  coreVersion: arg("core-version") ?? "0.0.0",
});
void host.stopped.then(() => process.exit(0));
