import { describe, expect, test } from "vitest";
import { IdempotencyLedger, StreamReceiver, StreamSender } from "./session.ts";

describe("idempotency", () => {
  test("a replayed request ID returns the stored result without re-running the mutation", async () => {
    const ledger = new IdempotencyLedger();
    let runs = 0;
    const run = async () => ({ n: ++runs });
    const a = await ledger.execute("r1", "h", run);
    const b = await ledger.execute("r1", "h", run);
    expect(runs).toBe(1);
    expect(b).toEqual(a);
  });

  test("concurrent duplicates (reconnect race) share one in-flight execution", async () => {
    const ledger = new IdempotencyLedger();
    let runs = 0;
    const run = async () => {
      await new Promise((r) => setTimeout(r, 5));
      return ++runs;
    };
    const [a, b] = await Promise.all([
      ledger.execute("r", "h", run),
      ledger.execute("r", "h", run),
    ]);
    expect([a, b, runs]).toEqual([1, 1, 1]);
  });

  test("same ID with a different payload hash is rejected as a conflict", async () => {
    const ledger = new IdempotencyLedger();
    await ledger.execute("r", "h1", async () => 1);
    await expect(ledger.execute("r", "h2", async () => 2)).rejects.toMatchObject({
      code: "idempotency_conflict",
    });
  });

  test("failed executions are remembered too, so a retry never repeats a partial mutation", async () => {
    const ledger = new IdempotencyLedger();
    let runs = 0;
    const boom = async () => {
      runs++;
      throw new Error("x");
    };
    await expect(ledger.execute("r", "h", boom)).rejects.toThrow("x");
    await expect(ledger.execute("r", "h", boom)).rejects.toThrow("x");
    expect(runs).toBe(1);
  });

  test("bounded capacity evicts the oldest completed entries", async () => {
    const ledger = new IdempotencyLedger({ capacity: 2 });
    for (const id of ["a", "b", "c"]) await ledger.execute(id, "h", async () => id);
    expect(ledger.has("a")).toBe(false);
    expect(ledger.has("c")).toBe(true);
  });
});

describe("streams", () => {
  test("sender assigns contiguous sequence numbers and exactly one terminal event", () => {
    const s = new StreamSender("s1");
    expect(s.data({ x: 1 }).seq).toBe(0);
    expect(s.data({ x: 2 }).seq).toBe(1);
    const end = s.end("complete");
    expect(end).toMatchObject({ seq: 2, state: "complete" });
    expect(() => s.data({})).toThrow();
    expect(() => s.end("complete")).toThrow();
  });

  test("receiver accepts in order, drops duplicates, flags gaps, and reports the resume point", () => {
    const r = new StreamReceiver("s1");
    const ev = (seq: number, state: "open" | "complete" = "open") => ({
      streamId: "s1",
      seq,
      state,
      data: seq,
    });
    expect(r.accept(ev(0))).toBe("accepted");
    expect(r.accept(ev(0))).toBe("duplicate");
    expect(r.accept(ev(2))).toBe("gap");
    expect(r.resumeFrom).toBe(1);
    expect(r.accept(ev(1))).toBe("accepted");
    expect(r.accept(ev(2, "complete"))).toBe("accepted");
    expect(r.terminal).toBe("complete");
    expect(r.accept(ev(3))).toBe("after_terminal");
  });

  test("receiver ignores events for other streams", () => {
    const r = new StreamReceiver("s1");
    expect(r.accept({ streamId: "other", seq: 0, state: "open" })).toBe("wrong_stream");
  });
});
