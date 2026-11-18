import { describe, expect, it } from "vitest";
import { UI_PROTOCOL_LIMITS } from "@citspark/protocol";
import { RendererBridge, helloVersion, parseRendererRequest } from "./bridge.ts";

describe("parseRendererRequest", () => {
  it("accepts a method name, a mutation flag and a JSON payload", () => {
    expect(parseRendererRequest({ method: "core.status", mutation: false, payload: null })).toEqual(
      {
        ok: true,
        value: { method: "core.status", mutation: false, payload: null },
      },
    );
  });

  it("rejects anything else with invalid_message", () => {
    for (const bad of [
      null,
      "core.status",
      { method: "core.status" },
      { method: "", mutation: false, payload: null },
      { method: "x".repeat(129), mutation: false, payload: null },
      { method: "core.status", mutation: "no", payload: null },
      { method: "core.status", mutation: false, payload: null, extra: 1 },
      { method: "core.status", mutation: false, payload: { f: () => 1 } },
      { method: "core.status", mutation: false, payload: Number.NaN },
    ]) {
      expect(parseRendererRequest(bad)).toMatchObject({
        ok: false,
        error: { code: "invalid_message" },
      });
    }
  });

  it("rejects oversized payloads with frame_too_large", () => {
    const payload = "x".repeat(UI_PROTOCOL_LIMITS.maxMessageBytes);
    expect(parseRendererRequest({ method: "m", mutation: false, payload })).toMatchObject({
      ok: false,
      error: { code: "frame_too_large" },
    });
  });
});

describe("RendererBridge", () => {
  function make(opts: { timeoutMs?: number; maxInFlight?: number } = {}) {
    const sent: { id: number; body: { id: string; v: number; method: string } }[] = [];
    const bridge = new RendererBridge({
      send: (id, body) => void sent.push({ id, body: body as never }),
      timeoutMs: opts.timeoutMs ?? 1000,
      maxInFlight: opts.maxInFlight ?? 2,
    });
    return { bridge, sent };
  }

  it("relays a request as a protocol envelope and resolves with the core's reply", async () => {
    const { bridge, sent } = make();
    const p = bridge.request({ method: "core.status", mutation: false, payload: null });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.body).toMatchObject({ v: 1, method: "core.status", mutation: false });
    const reply = { v: 1, id: sent[0]!.body.id, ok: true, result: { state: "ready" } };
    bridge.deliver(sent[0]!.id, reply);
    await expect(p).resolves.toEqual(reply);
  });

  it("ignores replies it did not ask for", async () => {
    const { bridge, sent } = make();
    const p = bridge.request({ method: "core.status", mutation: false, payload: null });
    bridge.deliver(999, { ok: true });
    bridge.deliver(sent[0]!.id, { v: 1, id: "other", ok: true, result: 1 });
    expect(bridge.inFlight).toBe(1);
    bridge.deliver(sent[0]!.id, { v: 1, id: sent[0]!.body.id, ok: true, result: 2 });
    await expect(p).resolves.toMatchObject({ result: 2 });
  });

  it("bounds the requests in flight", async () => {
    const { bridge } = make({ maxInFlight: 2 });
    void bridge.request({ method: "a", mutation: false, payload: null });
    void bridge.request({ method: "b", mutation: false, payload: null });
    await expect(
      bridge.request({ method: "c", mutation: false, payload: null }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "internal", message: expect.stringMatching(/too many/i) },
    });
  });

  it("times out a request the core never answers", async () => {
    const { bridge } = make({ timeoutMs: 20 });
    await expect(
      bridge.request({ method: "a", mutation: false, payload: null }),
    ).resolves.toMatchObject({
      ok: false,
      error: { code: "internal" },
    });
    expect(bridge.inFlight).toBe(0);
  });

  it("fails every pending request when the core goes away", async () => {
    const { bridge } = make();
    const a = bridge.request({ method: "a", mutation: false, payload: null });
    const b = bridge.request({ method: "b", mutation: false, payload: null });
    bridge.failAll("The core stopped.");
    await expect(a).resolves.toMatchObject({ ok: false, error: { message: "The core stopped." } });
    await expect(b).resolves.toMatchObject({ ok: false });
    expect(bridge.inFlight).toBe(0);
  });

  it("drops oversized replies from the core instead of passing them on", async () => {
    const { bridge, sent } = make();
    const p = bridge.request({ method: "a", mutation: false, payload: null });
    bridge.deliver(sent[0]!.id, {
      v: 1,
      id: sent[0]!.body.id,
      ok: true,
      result: "x".repeat(UI_PROTOCOL_LIMITS.maxMessageBytes),
    });
    await expect(p).resolves.toMatchObject({ ok: false, error: { code: "frame_too_large" } });
  });
  it("refuses replies that break the response schema, failing the request and clearing it", async () => {
    const malformed = (id: string): unknown[] => [
      { v: 2, id, ok: true, result: 1 },
      { v: "1", id, ok: true, result: 1 },
      { id, ok: true, result: 1 },
      { v: 1, id, ok: "yes", result: 1 },
      { v: 1, id, ok: true },
      { v: 1, id, ok: true, result: 1, extra: "smuggled" },
      { v: 1, id, ok: false, error: { code: "pwned", message: "x" } },
      { v: 1, id, ok: false, error: { code: "internal" } },
      { v: 1, id, ok: false, error: { code: "internal", message: "x", stack: "at /Users/..." } },
      { v: 1, id, ok: false, result: 1 },
      { type: "ui.hello.ok", version: 1, id, core: { version: "x" } },
    ];
    const { bridge, sent } = make({ maxInFlight: 32 });
    const count = malformed("probe").length;
    for (let i = 0; i < count; i++) {
      const p = bridge.request({ method: "a", mutation: false, payload: null });
      const { id, body } = sent[i]!;
      bridge.deliver(id, malformed(body.id)[i]);
      expect(bridge.inFlight).toBe(0);
      await expect(p).resolves.toEqual({
        v: 1,
        id: body.id,
        ok: false,
        error: { code: "internal", message: "The core sent an invalid reply." },
      });
    }
  });

  it("passes on a well-formed error reply unchanged", async () => {
    const { bridge, sent } = make();
    const p = bridge.request({ method: "a", mutation: false, payload: null });
    const reply = {
      v: 1,
      id: sent[0]!.body.id,
      ok: false,
      error: { code: "not_found", message: "Unknown method a.", details: { n: 1 } },
    };
    bridge.deliver(sent[0]!.id, reply);
    await expect(p).resolves.toEqual(reply);
  });
});

describe("helloVersion", () => {
  it("accepts only a well-formed ui.hello.ok within the shell's supported versions", () => {
    expect(helloVersion({ type: "ui.hello.ok", version: 1, core: { version: "0.1.0" } })).toBe(1);
    for (const bad of [
      null,
      { type: "ui.hello.ok", version: 2, core: { version: "0.1.0" } },
      { type: "ui.hello.ok", version: 1.5, core: { version: "0.1.0" } },
      { type: "ui.hello.ok", version: 1 },
      { type: "ui.hello.ok", version: 1, core: { version: "0.1.0" }, extra: 1 },
      { type: "ui.hello.error", error: { code: "incompatible", message: "x" } },
    ]) {
      expect(helloVersion(bad)).toBeUndefined();
    }
  });
});
