/**
 * Keeps the core's process alive (ADR 0001): starts it, waits for `core.ready`, restarts it after a crash with
 * backoff and a bounded budget, and stops it by asking first and killing after a grace period. It does not
 * import Electron; `main.ts` adapts `utilityProcess` to {@link CoreChild}, and tests adapt Node's `fork`.
 */

/** One running core process. */
export interface CoreChild {
  readonly pid: number | undefined;
  post(message: unknown): void;
  onMessage(listener: (message: unknown) => void): void;
  /** Called once when the process has exited (it is reaped). */
  onExit(listener: (code: number | null) => void): void;
  kill(): void;
}

export type CoreState =
  | { state: "starting"; attempt: number }
  | { state: "ready"; pid: number | undefined; coreVersion: string; schemaVersion: number }
  | { state: "restarting"; attempt: number; reason: string }
  | { state: "failed"; code: string; message: string }
  | { state: "stopped" };

export interface SupervisorOptions {
  spawn(): CoreChild;
  onState(state: CoreState): void;
  onReply(envelopeId: number, body: unknown): void;
  /** `core.ready` must arrive within this time, or the start counts as a crash. */
  startTimeoutMs: number;
  /** After `core.shutdown`, the process is killed if it has not exited within this time. */
  stopGraceMs: number;
  /** Automatic restarts allowed within `restartWindowMs` before the supervisor gives up. */
  maxRestarts: number;
  restartWindowMs: number;
  backoffMs(attempt: number): number;
}

export const DEFAULT_SUPERVISOR_LIMITS = Object.freeze({
  startTimeoutMs: 15_000,
  stopGraceMs: 3_000,
  maxRestarts: 3,
  restartWindowMs: 60_000,
  backoffMs: (attempt: number) => Math.min(250 * 2 ** (attempt - 1), 4_000),
});

const CRASH_MESSAGES: Record<string, string> = {
  core_crashed:
    "The Citspark core stopped unexpectedly several times. Try again, or restart Citspark.",
  core_start_timeout: "The Citspark core did not start in time.",
};

interface Running {
  child: CoreChild;
  ready: boolean;
  exited: Promise<void>;
  /** Set when the supervisor itself ended the process, so its exit is not treated as a crash. */
  expected: boolean;
  startTimer: ReturnType<typeof setTimeout> | undefined;
}

export class CoreSupervisor {
  readonly #opts: SupervisorOptions;
  #state: CoreState = { state: "stopped" };
  #running: Running | undefined;
  #crashes: number[] = [];
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  #stopping = false;

  constructor(opts: SupervisorOptions) {
    this.#opts = opts;
  }

  get state(): CoreState {
    return this.#state;
  }

  start(): void {
    if (this.#running || this.#restartTimer) return;
    this.#stopping = false;
    this.#spawn(1);
  }

  /** User-initiated retry from the failed state; resets the crash budget. */
  retry(): void {
    if (this.#state.state !== "failed") return;
    this.#crashes = [];
    this.start();
  }

  /** Relays one envelope to a ready core. */
  send(envelopeId: number, body: unknown): boolean {
    const r = this.#running;
    if (!r || !r.ready || this.#stopping) return false;
    try {
      r.child.post({ type: "core.message", id: envelopeId, body });
      return true;
    } catch {
      return false;
    }
  }

  /** Asks the core to close its library, kills it after the grace period, and waits until it has exited. */
  async stop(): Promise<void> {
    this.#stopping = true;
    if (this.#restartTimer) clearTimeout(this.#restartTimer);
    this.#restartTimer = undefined;
    const r = this.#running;
    if (r) await this.#terminate(r, true);
    this.#setState({ state: "stopped" });
  }

  #setState(state: CoreState): void {
    this.#state = state;
    this.#opts.onState(state);
  }

  #spawn(attempt: number): void {
    this.#setState({ state: "starting", attempt });
    let child: CoreChild;
    try {
      child = this.#opts.spawn();
    } catch {
      this.#setState({
        state: "failed",
        code: "core_spawn_failed",
        message: "The Citspark core could not be started.",
      });
      return;
    }
    let exitedResolve!: () => void;
    const r: Running = {
      child,
      ready: false,
      exited: new Promise<void>((res) => (exitedResolve = res)),
      expected: false,
      startTimer: undefined,
    };
    this.#running = r;
    r.startTimer = setTimeout(() => {
      r.startTimer = undefined;
      if (!r.ready) this.#crashed(r, "core_start_timeout", attempt);
    }, this.#opts.startTimeoutMs);
    child.onMessage((m) => this.#onMessage(r, m));
    child.onExit(() => {
      exitedResolve();
      if (r.startTimer) clearTimeout(r.startTimer);
      if (this.#running === r) this.#running = undefined;
      if (!r.expected && !this.#stopping) this.#crashed(r, "core_crashed", attempt);
    });
  }

  #onMessage(r: Running, raw: unknown): void {
    if (this.#running !== r) return;
    const m = raw as { type?: unknown } & Record<string, unknown>;
    if (m === null || typeof m !== "object") return;
    if (m.type === "core.ready" && !r.ready) {
      r.ready = true;
      if (r.startTimer) clearTimeout(r.startTimer);
      r.startTimer = undefined;
      const core = m.core as { version?: unknown } | undefined;
      const library = m.library as { schemaVersion?: unknown } | undefined;
      this.#setState({
        state: "ready",
        pid: r.child.pid,
        coreVersion: typeof core?.version === "string" ? core.version.slice(0, 64) : "unknown",
        schemaVersion: typeof library?.schemaVersion === "number" ? library.schemaVersion : 0,
      });
    } else if (m.type === "core.failed" && !r.ready) {
      // A deterministic start failure (for example an unreadable library). Restarting would fail the same
      // way, so report it and wait for the user.
      const error = m.error as { code?: unknown; message?: unknown } | undefined;
      const code = typeof error?.code === "string" ? error.code.slice(0, 64) : "core_failed";
      const message =
        typeof error?.message === "string"
          ? error.message.slice(0, 512)
          : "The Citspark core failed to start.";
      void this.#terminate(r, true).then(() => {
        if (!this.#stopping) this.#setState({ state: "failed", code, message });
      });
    } else if (m.type === "core.reply" && r.ready && Number.isSafeInteger(m.id)) {
      try {
        this.#opts.onReply(m.id as number, m.body);
      } catch {
        // A bad reply must never take the shell down; the bridge has already settled or dropped it.
        console.warn(`[citspark] dropped a core reply for envelope ${String(m.id)}`);
      }
    }
  }

  #crashed(r: Running, code: string, attempt: number): void {
    if (this.#stopping) return;
    r.expected = true;
    // Make sure the process is gone (a start timeout leaves it running) before deciding what to do.
    void this.#terminate(r, false);
    const now = Date.now();
    this.#crashes = this.#crashes.filter((t) => now - t < this.#opts.restartWindowMs);
    this.#crashes.push(now);
    if (this.#crashes.length > this.#opts.maxRestarts) {
      this.#setState({
        state: "failed",
        code,
        message: CRASH_MESSAGES[code] ?? "The Citspark core failed.",
      });
      return;
    }
    const next = attempt + 1;
    this.#setState({ state: "restarting", attempt: next, reason: code });
    this.#restartTimer = setTimeout(
      () => {
        this.#restartTimer = undefined;
        void r.exited.then(() => {
          if (!this.#stopping && !this.#running) this.#spawn(next);
        });
      },
      this.#opts.backoffMs(next - 1),
    );
  }

  async #terminate(r: Running, graceful: boolean): Promise<void> {
    r.expected = r.expected || graceful;
    if (r.startTimer) clearTimeout(r.startTimer);
    r.startTimer = undefined;
    if (graceful) {
      try {
        r.child.post({ type: "core.shutdown" });
      } catch {
        // Already gone; the exit wait below settles at once.
      }
      const killer = setTimeout(() => r.child.kill(), this.#opts.stopGraceMs);
      await r.exited;
      clearTimeout(killer);
    } else {
      r.child.kill();
      await r.exited;
    }
    if (this.#running === r) this.#running = undefined;
  }
}
