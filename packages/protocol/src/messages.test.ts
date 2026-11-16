import { describe, expect, test } from "vitest";
import {
  ErrorCode,
  negotiateVersion,
  parseHello,
  parseRequest,
  protocolError,
  SUPPORTED_VERSIONS,
  encodeFrame,
} from "./index.ts";

const hello = {
  type: "hello",
  versions: { min: 1, max: 1 },
  client: { kind: "extension", version: "0.1.0" },
  channel: "session",
};

describe("hello negotiation", () => {
  test("chooses the highest mutually supported version", () => {
    const r = negotiateVersion({ min: 1, max: 5 }, { min: 1, max: 3 });
    expect(r).toEqual({ ok: true, version: 3 });
  });

  test("incompatible ranges yield a structured incompatible error the client can display", () => {
    const r = negotiateVersion({ min: 7, max: 9 }, SUPPORTED_VERSIONS);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe(ErrorCode.Incompatible);
      expect(r.error.message).toMatch(/update/i);
      expect(r.error.details).toEqual({ clientMin: 7, clientMax: 9, serverMin: 1, serverMax: 1 });
    }
  });

  test("hello validation rejects bad ranges, unknown client kinds and extra keys", () => {
    expect(parseHello(hello).success).toBe(true);
    expect(parseHello({ ...hello, versions: { min: 3, max: 1 } }).success).toBe(false);
    expect(parseHello({ ...hello, client: { kind: "rogue", version: "1" } }).success).toBe(false);
    expect(parseHello({ ...hello, extra: 1 }).success).toBe(false);
    expect(parseHello({ ...hello, channel: "admin" }).success).toBe(false);
  });
});

describe("requests", () => {
  const base = {
    v: 1,
    id: "0b6f2f0e-6f0e-4f0e-8f0e-0123456789ab",
    method: "search.query",
    payload: {},
  };

  test("mutations must carry a request ID; non-mutations too, for correlation", () => {
    expect(parseRequest({ ...base, mutation: false }).success).toBe(true);
    expect(parseRequest({ ...base, mutation: true }).success).toBe(true);
    const noId: Record<string, unknown> = { ...base, mutation: true };
    delete noId.id;
    expect(parseRequest(noId).success).toBe(false);
    expect(parseRequest({ ...base, id: "", mutation: true }).success).toBe(false);
  });

  test("errors are structured and never leak arbitrary fields", () => {
    const e = protocolError(ErrorCode.FrameTooLarge, "too big", { max: 1 });
    expect(e).toEqual({ code: "frame_too_large", message: "too big", details: { max: 1 } });
    expect(encodeFrame({ error: e }).length).toBeGreaterThan(4);
  });
});
