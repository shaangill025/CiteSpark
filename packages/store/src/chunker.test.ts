import { describe, expect, it } from "vitest";
import { DEFAULT_CHUNKER, chunkText, type ChunkerOptions } from "./chunker.ts";

const small: ChunkerOptions = { ...DEFAULT_CHUNKER, maxChars: 40, overlapChars: 8 };

function expectExact(text: string, opts: ChunkerOptions = small): void {
  const spans = chunkText(text, opts);
  for (const s of spans) {
    expect(text.slice(s.start, s.end)).toBe(s.text);
    expect(s.end).toBeGreaterThan(s.start);
    expect(s.text.length).toBeLessThanOrEqual(opts.maxChars);
    expect(s.text).toBe(s.text.trim());
    // Never splits a surrogate pair or detaches a combining mark.
    expect(s.text.isWellFormed()).toBe(true);
    expect(/^\p{M}/u.test(s.text)).toBe(false);
  }
  for (let i = 1; i < spans.length; i++)
    expect(spans[i]!.start).toBeGreaterThan(spans[i - 1]!.start);
}

describe("chunkText", () => {
  it("returns no chunks for empty or whitespace-only text", () => {
    expect(chunkText("", small)).toEqual([]);
    expect(chunkText(" \n\t\u3000 ", small)).toEqual([]);
  });

  it("keeps a short post as one chunk with exact offsets around trimmed whitespace", () => {
    const text = "  A short synthetic post.\n";
    expect(chunkText(text, small)).toEqual([
      { start: 2, end: 25, text: "A short synthetic post." },
    ]);
  });

  it("splits long text at sentence or word boundaries with bounded overlap", () => {
    const text =
      "Alpha beta gamma delta. Epsilon zeta eta theta iota. Kappa lambda mu nu xi omicron pi rho.";
    const spans = chunkText(text, small);
    expect(spans.length).toBeGreaterThan(1);
    expectExact(text);
    expect(spans[0]!.text).toBe("Alpha beta gamma delta.");
    // Chunks start on a word boundary and cover the whole text.
    for (const s of spans) expect(s.start === 0 || /\s/.test(text[s.start - 1]!)).toBe(true);
    expect(spans.at(-1)!.end).toBe(text.length);
    for (let i = 1; i < spans.length; i++) {
      expect(spans[i]!.start).toBeLessThanOrEqual(spans[i - 1]!.end);
      expect(spans[i - 1]!.end - spans[i]!.start).toBeLessThanOrEqual(small.overlapChars);
    }
  });

  it("covers every non-whitespace character", () => {
    const text = "word ".repeat(300) + "end";
    const spans = chunkText(text, small);
    const covered = new Array<boolean>(text.length).fill(false);
    for (const s of spans) for (let i = s.start; i < s.end; i++) covered[i] = true;
    for (let i = 0; i < text.length; i++) if (!/\s/.test(text[i]!)) expect(covered[i]).toBe(true);
  });

  it("does not emit sliver chunks when the overlap precedes a long whitespace run", () => {
    const cases: [string, ChunkerOptions][] = [
      [
        "aaaa bbbb cccc dddd" + " ".repeat(30) + "eeee",
        { ...small, maxChars: 20, overlapChars: 5 },
      ],
      [
        "lorem ipsum dolor sit amet ".repeat(30) + "\n".repeat(900) + "next section",
        DEFAULT_CHUNKER,
      ],
    ];
    for (const [text, opts] of cases) {
      expectExact(text, opts);
      const spans = chunkText(text, opts);
      for (let i = 1; i < spans.length; i++)
        expect(spans[i]!.end).toBeGreaterThan(spans[i - 1]!.end);
      expect(spans.at(-1)!.text.endsWith(text.trim().slice(-4))).toBe(true);
    }
  });

  it("preserves Unicode: emoji, ZWJ sequences, combining marks, CJK without spaces", () => {
    const emoji = "👩‍👩‍👧‍👦".repeat(30);
    const combining = "e\u0301".repeat(60);
    const cjk = "日本語のテキストは空白なしで続きます".repeat(6) + "。次の文です。";
    const korean = "한국어 문장입니다 ".repeat(20);
    for (const text of [emoji, combining, cjk, korean, `${cjk} ${emoji} ${combining}`])
      expectExact(text);
    const zwj = chunkText(emoji, small);
    for (const s of zwj) expect(s.text.length % "👩‍👩‍👧‍👦".length).toBe(0);
  });

  it("makes progress when a single grapheme is longer than the window", () => {
    const zalgo = "a" + "\u0301".repeat(100) + " tail";
    const spans = chunkText(zalgo, small);
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) expect(zalgo.slice(s.start, s.end)).toBe(s.text);
  });

  it("is deterministic and rejects invalid options", () => {
    const text = "Determinism matters. ".repeat(50);
    expect(chunkText(text, small)).toEqual(chunkText(text, small));
    expect(() => chunkText(text, { ...small, maxChars: 0 })).toThrow(RangeError);
    expect(() => chunkText(text, { ...small, overlapChars: 20 })).toThrow(RangeError);
  });
});
