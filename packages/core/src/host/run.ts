import {
  CoreStartError,
  startDesktopCore,
  type DesktopCore,
  type DesktopCoreOptions,
} from "./core.ts";

/** The message channel to the shell. Electron's `process.parentPort` is adapted to this in the app. */
export interface HostPort {
  onMessage(listener: (data: unknown) => void): void;
  post(data: unknown): void;
}

/** Messages the core sends to the shell. */
export type HostEvent =
  | {
      type: "core.ready";
      core: { version: string; pid: number };
      library: { schemaVersion: number };
    }
  | { type: "core.failed"; error: { code: string; message: string } }
  | { type: "core.reply"; id: number; body: unknown }
  | { type: "core.stopped" };

export interface RunningHost {
  /** Resolves once the library is open; rejects with the reported failure. */
  readonly started: Promise<DesktopCore>;
  /** Resolves after `core.shutdown` once the library is closed and `core.stopped` was sent. */
  readonly stopped: Promise<void>;
}

/**
 * Runs the core behind a message port. The shell sends `core.message` envelopes (renderer protocol messages
 * it has already validated) and `core.shutdown`; anything else is ignored. The shell must exit the process
 * after `core.stopped`. Failure reports carry a code and a fixed message, never paths or stacks.
 */
export function runCoreHost(port: HostPort, opts: DesktopCoreOptions): RunningHost {
  let resolveStopped!: () => void;
  const stopped = new Promise<void>((r) => (resolveStopped = r));
  const started = startDesktopCore(opts);
  started.then(
    (core) => {
      const s = core.status();
      port.post({
        type: "core.ready",
        core: { version: s.core.version, pid: s.core.pid },
        library: { schemaVersion: s.library.schemaVersion },
      } satisfies HostEvent);
    },
    (e: unknown) => {
      const err = e instanceof CoreStartError ? e : new CoreStartError("library_unreadable");
      port.post({
        type: "core.failed",
        error: { code: err.code, message: err.message },
      } satisfies HostEvent);
    },
  );
  let stopping = false;
  port.onMessage((data) => {
    const msg = data as { type?: unknown; id?: unknown; body?: unknown } | null;
    if (msg === null || typeof msg !== "object") return;
    if (msg.type === "core.shutdown") {
      if (stopping) return;
      stopping = true;
      void started
        .then((core) => core.close())
        .catch(() => undefined)
        .then(() => {
          port.post({ type: "core.stopped" } satisfies HostEvent);
          resolveStopped();
        });
      return;
    }
    if (msg.type !== "core.message" || !Number.isSafeInteger(msg.id) || stopping) return;
    const id = msg.id as number;
    void started.then(
      async (core) => {
        port.post({
          type: "core.reply",
          id,
          body: await core.handle(msg.body),
        } satisfies HostEvent);
      },
      () => undefined,
    );
  });
  return { started, stopped };
}
