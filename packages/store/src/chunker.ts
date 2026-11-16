/**
 * Splits a source version's text into chunks whose offsets map back to the exact text (RET-03).
 * Offsets are UTF-16 code unit indices into the version text, so `text.slice(start, end) === chunk.text`.
 * Cuts never split a grapheme cluster, so emoji, ZWJ sequences, and combining marks survive (LAN-01).
 */
export interface ChunkerOptions {
  /** Identifies the boundary rules; recorded per index generation so a rule change means a new generation. */
  algorithm: "boundary-v1";
  /** Upper bound on chunk length in UTF-16 code units, except for a single grapheme longer than this. */
  maxChars: number;
  /** Text repeated from the end of one chunk at the start of the next. Must be under half of `maxChars`. */
  overlapChars: number;
}

/** About 1,000 characters with 150 of overlap (docs/f0/resolved-engineering-details.md; overlap PROPOSED). */
export const DEFAULT_CHUNKER: ChunkerOptions = {
  algorithm: "boundary-v1",
  maxChars: 1000,
  overlapChars: 150,
};

export interface ChunkSpan {
  start: number;
  end: number;
  text: string;
}

const WS = /\s/;
const CJK_TERMINATOR = /[。！？]/;
const TERMINATOR = /[.!?。！？]/;
const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

export function chunkText(text: string, options: ChunkerOptions = DEFAULT_CHUNKER): ChunkSpan[] {
  const { maxChars: max, overlapChars: overlap } = options;
  if (!Number.isInteger(max) || max < 1)
    throw new RangeError("maxChars must be a positive integer");
  if (!Number.isInteger(overlap) || overlap < 0 || overlap * 2 >= max) {
    throw new RangeError("overlapChars must be a non-negative integer under half of maxChars");
  }
  const spans: ChunkSpan[] = [];
  let start = skipWhitespace(text, 0);
  let prevEnd = -1;
  let prevCut = 0;
  while (start < text.length) {
    const cut = text.length - start <= max ? text.length : findBreak(text, start, max);
    const end = trimEnd(text, start, cut);
    if (end <= prevEnd) {
      // The overlap landed before a whitespace run too long to cross; restart after it without overlap.
      start = skipWhitespace(text, prevCut);
      continue;
    }
    spans.push({ start, end, text: text.slice(start, end) });
    if (cut >= text.length) break;
    prevEnd = end;
    prevCut = cut;
    start = skipWhitespace(text, nextStart(text, start, end, cut, overlap));
  }
  return spans;
}

/** Best cut in (start, start + max]: paragraph, then sentence, then whitespace, then grapheme boundary. */
function findBreak(text: string, start: number, max: number): number {
  const hard = start + max;
  const floor = start + Math.floor(max / 2);
  const p = text.lastIndexOf("\n\n", hard - 2);
  if (p >= floor) return p + 2;
  for (let i = hard - 1; i >= floor; i--) {
    const c = text[i]!;
    if (CJK_TERMINATOR.test(c)) return i + 1;
    if (TERMINATOR.test(c) && WS.test(text[i + 1] ?? " ")) return i + 1;
  }
  for (let i = hard; i > floor; i--) if (WS.test(text[i]!)) return i;
  return graphemeCut(text, start, hard);
}

/** Largest grapheme boundary in (start, hard]; the next boundary when one grapheme exceeds the window. */
function graphemeCut(text: string, start: number, hard: number): number {
  const seg = segmenter.segment(text).containing(hard);
  if (!seg || seg.index === hard) return hard;
  return seg.index > start ? seg.index : seg.index + seg.segment.length;
}

/** Next chunk starts about `overlap` units before the cut, moved forward to a word or grapheme start. */
function nextStart(text: string, start: number, end: number, cut: number, overlap: number): number {
  if (overlap === 0) return cut;
  const from = Math.max(start + 1, end - overlap);
  for (let i = from; i < end; i++) if (WS.test(text[i - 1]!) && !WS.test(text[i]!)) return i;
  // No word boundary in the overlap window (for example CJK): start at the first grapheme boundary.
  const g = graphemeCeil(text, from);
  return g > start && g < cut ? g : cut;
}

/** Smallest grapheme boundary at or after `pos`. */
function graphemeCeil(text: string, pos: number): number {
  const seg = segmenter.segment(text).containing(pos);
  if (!seg || seg.index === pos) return pos;
  return seg.index + seg.segment.length;
}

function skipWhitespace(text: string, i: number): number {
  while (i < text.length && WS.test(text[i]!)) i++;
  return i;
}

function trimEnd(text: string, start: number, end: number): number {
  while (end > start && WS.test(text[end - 1]!)) end--;
  return end;
}
