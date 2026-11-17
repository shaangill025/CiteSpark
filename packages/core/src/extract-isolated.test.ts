import { describe, expect, it, vi } from "vitest";
import { ExtractionPool } from "./extract-isolated.ts";

const FAULTS = new URL("./testing/extract-faults.ts", import.meta.url);
const input = (mode: string) => ({
  body: new Uint8Array(),
  contentType: mode,
  charset: null,
  finalUrl: "https://example.test/",
});
const after = (ms: number) => performance.now() + ms;

describe("ExtractionPool worker lifecycle", () => {
  it("terminates a running worker and releases its slot when the caller cancels", async () => {
    const pool = new ExtractionPool({ maxWorkers: 1 }, FAULTS);
    const controller = new AbortController();
    const running = pool.extract(input("fault/hang"), after(30_000), controller.signal);
    await vi.waitFor(() => expect(pool.running).toBe(1));
    controller.abort(new Error("synthetic cancel"));
    await expect(running).rejects.toThrow("synthetic cancel");
    await vi.waitFor(() => expect(pool.running).toBe(0));
  });

  it("rejects a worker that fails at startup or exits without replying, then frees its slot", async () => {
    const pool = new ExtractionPool({ maxWorkers: 1 }, FAULTS);
    await expect(pool.extract(input("fault/startup"), after(10_000))).rejects.toThrow(
      "synthetic startup failure",
    );
    await expect(pool.extract(input("fault/exit"), after(10_000))).rejects.toThrow(
      "exited with code 3",
    );
    await vi.waitFor(() => expect(pool.running).toBe(0));
  });

  it("settles once: a second reply is ignored and a reply after the deadline never arrives", async () => {
    const pool = new ExtractionPool({ maxWorkers: 1 }, FAULTS);
    expect(await pool.extract(input("fault/twice"), after(10_000))).toMatchObject({
      page: { text: "first" },
    });
    expect(await pool.extract(input("fault/late"), after(300))).toEqual({ kind: "deadline" });
    await vi.waitFor(() => expect(pool.running).toBe(0));
  });

  it("counts queue time against the deadline and drops cancelled or expired waiters", async () => {
    const pool = new ExtractionPool({ maxWorkers: 1, maxQueued: 2 }, FAULTS);
    const holder = new AbortController();
    const held = pool.extract(input("fault/hang"), after(30_000), holder.signal);
    const expiring = pool.extract(input("fault/twice"), after(200));
    const cancelled = new AbortController();
    const dropped = pool.extract(input("fault/twice"), after(30_000), cancelled.signal);
    expect(pool.queued).toBe(2);
    cancelled.abort(new Error("synthetic cancel"));
    await expect(dropped).rejects.toThrow("synthetic cancel");
    expect(await expiring).toEqual({ kind: "deadline" });
    expect(pool.queued).toBe(0);
    holder.abort(new Error("release"));
    await expect(held).rejects.toThrow("release");
    await vi.waitFor(() => expect(pool.running).toBe(0));
  });
});
