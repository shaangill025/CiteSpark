/**
 * Pacing for passive capture (CAP-05, ADR 0005). The extension never sends requests; it only decides
 * when to scroll so X's own code loads the next page. Every scroll, including catch-up scrolls over
 * already committed pages, counts against a persisted daily page budget.
 */
export interface PacerConfig {
  /** Jittered pause between an acknowledged page and the next scroll. */
  minDelayMs: number;
  maxDelayMs: number;
  /** Base and cap for exponential backoff on 429 and transient errors. */
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** 429s in a row before the job stops as rate limited. */
  maxRateLimitRetries: number;
  /** 5xx or network errors in a row before the job stops as failed. */
  maxTransientRetries: number;
  /** A Retry-After longer than this stops the job instead of holding the tab. */
  maxRetryAfterHoldMs: number;
  /** Wait for X to load the next page after a scroll before scrolling again. */
  noProgressMs: number;
  /** Scrolls without any response before the job pauses with `no_progress`. */
  maxNoProgressScrolls: number;
  defaultDailyPageBudget: number;
  maxDailyPageBudget: number;
}

export const RELEASE_PACING: PacerConfig = Object.freeze({
  minDelayMs: 2500,
  maxDelayMs: 6000,
  baseBackoffMs: 30_000,
  maxBackoffMs: 15 * 60_000,
  maxRateLimitRetries: 3,
  maxTransientRetries: 3,
  maxRetryAfterHoldMs: 30 * 60_000,
  noProgressMs: 30_000,
  maxNoProgressScrolls: 3,
  defaultDailyPageBudget: 300,
  maxDailyPageBudget: 1000,
});

/** Same rules, shorter clocks: used only by the `dist-test` build that the T02 harness loads. */
export const TEST_PACING: PacerConfig = Object.freeze({
  ...RELEASE_PACING,
  minDelayMs: 60,
  maxDelayMs: 140,
  baseBackoffMs: 200,
  maxBackoffMs: 2000,
  maxRetryAfterHoldMs: 5000,
  noProgressMs: 1500,
});

export function nextScrollDelay(cfg: PacerConfig, random: () => number): number {
  return Math.round(cfg.minDelayMs + random() * (cfg.maxDelayMs - cfg.minDelayMs));
}

/** Retry-After as delta-seconds or an HTTP date, in ms from now; null when absent or invalid. */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const v = value.trim();
  if (/^[0-9]{1,9}$/.test(v)) return Number(v) * 1000;
  if (!/[A-Za-z]/.test(v)) return null;
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

/** Exponential backoff with jitter, capped, and never shorter than the server's Retry-After. */
export function backoffDelay(
  cfg: PacerConfig,
  attempt: number,
  random: () => number,
  retryAfterMs: number | null,
): number {
  const exp = Math.min(cfg.maxBackoffMs, cfg.baseBackoffMs * 2 ** Math.min(attempt, 20));
  const jittered = Math.round(exp * (0.5 + random() / 2));
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** Small async key-value store: IndexedDB in the extension, a Map in tests. */
export interface Kv {
  get<T>(key: string): Promise<T | undefined>;
  set(key: string, value: unknown): Promise<void>;
}

export function memoryKv(): Kv {
  const m = new Map<string, unknown>();
  return {
    get: async <T>(k: string) => structuredClone(m.get(k)) as T | undefined,
    set: async (k, v) => void m.set(k, structuredClone(v)),
  };
}

const localDay = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};

/** Pages per local day; stored as counts only, never content. */
export class DailyBudget {
  readonly #cfg: PacerConfig;
  readonly #kv: Kv;

  constructor(cfg: PacerConfig, kv: Kv) {
    this.#cfg = cfg;
    this.#kv = kv;
  }

  async limit(): Promise<number> {
    const v = await this.#kv.get<number>("budget.limit");
    return typeof v === "number" ? v : this.#cfg.defaultDailyPageBudget;
  }

  /** Users may lower the budget; it is clamped to 1..maxDailyPageBudget. */
  async setLimit(n: number): Promise<number> {
    const v = Math.max(1, Math.min(this.#cfg.maxDailyPageBudget, Math.floor(n) || 1));
    await this.#kv.set("budget.limit", v);
    return v;
  }

  async used(nowMs: number): Promise<number> {
    const u = await this.#kv.get<{ day: string; pages: number }>("budget.used");
    return u?.day === localDay(nowMs) ? u.pages : 0;
  }

  /** Reserves one page; false once today's budget is spent. */
  async consume(nowMs: number): Promise<boolean> {
    const used = await this.used(nowMs);
    if (used >= (await this.limit())) return false;
    await this.#kv.set("budget.used", { day: localDay(nowMs), pages: used + 1 });
    return true;
  }
}
