import { describe, expect, it } from "vitest";
import { decodeBody } from "./decode.ts";

const latin1 = (s: string) => Buffer.from(s, "latin1");

describe("decodeBody", () => {
  it("reads a quoted http-equiv charset and reports the resolved encoding", () => {
    const r = decodeBody(
      latin1(`<meta http-equiv=content-type content="text/html; charset='iso-8859-1'"><p>\xe9`),
      "text/html",
      null,
    );
    expect(r).toMatchObject({ ok: true, encoding: "windows-1252" });
    expect(r.ok && r.text.endsWith("é")).toBe(true);
  });

  it("treats a meta-declared UTF-16 as UTF-8, as the HTML prescan does", () => {
    expect(decodeBody(Buffer.from('<meta charset="utf-16"><p>é'), "text/html", null)).toMatchObject(
      {
        ok: true,
        encoding: "utf-8",
      },
    );
  });

  it("only honors meta declarations within the first 1024 bytes", () => {
    const late = latin1(`<!-- ${"x".repeat(1100)} --><meta charset="windows-1252"><p>\xe9`);
    expect(decodeBody(late, "text/html", null)).toMatchObject({
      ok: false,
      reason: "invalid_text_encoding",
    });
  });

  it("does not prescan meta declarations for XHTML or plain text", () => {
    const body = latin1('<meta charset="windows-1252"><p>\xe9');
    for (const mime of ["application/xhtml+xml", "text/plain"]) {
      expect(decodeBody(body, mime, null), mime).toMatchObject({
        ok: false,
        reason: "invalid_text_encoding",
      });
    }
  });

  it("lets a byte order mark override the header charset", () => {
    const body = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("Café")]);
    expect(decodeBody(body, "text/plain", "windows-1252")).toEqual({
      ok: true,
      text: "Café",
      encoding: "utf-8",
    });
  });

  it("bounds and sanitizes an unsupported label in the gap detail", () => {
    const r = decodeBody(Buffer.from("x"), "text/plain", `bad\u0001${"y".repeat(200)}`);
    expect(r).toMatchObject({ ok: false, reason: "unsupported_charset" });
    expect(!r.ok && r.detail.length).toBeLessThan(120);
    expect(!r.ok && r.detail).not.toContain("\u0001");
  });
});
