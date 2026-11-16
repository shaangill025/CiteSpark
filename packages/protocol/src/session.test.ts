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

  test("full ledger fails closed: never forgets a completed ID, rejects new IDs instead", async () => {
    const ledger = new IdempotencyLedger({ capacity: 2 });
    const runs: string[] = [];
    const run = (id: string) => async () => {
      runs.push(id);
      return id;
    };
    await ledger.execute("a", "h", run("a"));
    await ledger.execute("b", "h", run("b"));
    await expect(ledger.execute("c", "h", run("c"))).rejects.toMatchObject({
      code: "idempotency_exhausted",
    });
    expect(ledger.has("c")).toBe(false);
    // Replay after capacity is reached must return the stored outcome, not run the mutation again.
    await expect(ledger.execute("a", "h", run("a"))).resolves.toBe("a");
    expect(ledger.has("a")).toBe(true);
    expect(runs).toEqual(["a", "b"]);
  });

  test("a failed mutation is still remembered after capacity is reached", async () => {
    const ledger = new IdempotencyLedger({ capacity: 1 });
    let runs = 0;
    const boom = async () => {
      runs++;
      throw new Error("partial");
    };
    await expect(ledger.execute("a", "h", boom)).rejects.toThrow("partial");
    await expect(ledger.execute("b", "h", async () => 1)).rejects.toMatchObject({
      code: "idempotency_exhausted",
    });
    await expect(ledger.execute("a", "h", boom)).rejects.toThrow("partial");
    expect(runs).toBe(1);
  });

  test("capacity must be a positive integer", () => {
    expect(() => new IdempotencyLedger({ capacity: 0 })).toThrow(RangeError);
    expect(() => new IdempotencyLedger({ capacity: 1.5 })).toThrow(RangeError);
  });

  test("a synchronous throw from the mutation is remembered like a rejection", async () => {
    const ledger = new IdempotencyLedger();
    let runs = 0;
    const boom = (): Promise<never> => {
      runs++;
      throw new Error("sync");
    };
    await expect(ledger.execute("r", "h", boom)).rejects.toThrow("sync");
    await expect(ledger.execute("r", "h", boom)).rejects.toThrow("sync");
    expect(runs).toBe(1);
  });

  test("a mutation that re-enters with its own ID shares the reserved execution", async () => {
    const ledger = new IdempotencyLedger({ capacity: 1 });
    let runs = 0;
    let inner: Promise<string> | undefined;
    const outer = ledger.execute("a", "h", async () => {
      runs++;
      inner = ledger.execute("a", "h", async () => {
        runs++;
        return "inner";
      });
      return "outer";
    });
    expect(inner).toBe(outer);
    await expect(outer).resolves.toBe("outer");
    await expect(inner).resolves.toBe("outer");
    await expect(ledger.execute("a", "h", async () => "retry")).resolves.toBe("outer");
    expect(runs).toBe(1);
  });

  test("a mutation that re-enters with its own ID and another payload is a conflict", async () => {
    const ledger = new IdempotencyLedger();
    let inner: Promise<number> | undefined;
    await ledger.execute("a", "h1", async () => {
      inner = ledger.execute("a", "h2", async () => 2);
      inner.catch(() => undefined);
      return 1;
    });
    await expect(inner).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  test("a mutation that re-enters with a new ID cannot exceed capacity", async () => {
    const ledger = new IdempotencyLedger({ capacity: 1 });
    let runs = 0;
    let inner: Promise<number> | undefined;
    await ledger.execute("a", "h", async () => {
      inner = ledger.execute("b", "h", async () => ++runs);
      inner.catch(() => undefined);
      return 1;
    });
    await expect(inner).rejects.toMatchObject({ code: "idempotency_exhausted" });
    expect(ledger.has("b")).toBe(false);
    expect(runs).toBe(0);
  });

  test("a synchronous throw after re-entry is retained for the reserved ID", async () => {
    const ledger = new IdempotencyLedger({ capacity: 1 });
    let runs = 0;
    let inner: Promise<never> | undefined;
    const boom = (): Promise<never> => {
      runs++;
      inner = ledger.execute("r", "h", boom);
      inner.catch(() => undefined);
      throw new Error("sync");
    };
    await expect(ledger.execute("r", "h", boom)).rejects.toThrow("sync");
    await expect(inner).rejects.toThrow("sync");
    await expect(ledger.execute("r", "h", boom)).rejects.toThrow("sync");
    expect(runs).toBe(1);
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
