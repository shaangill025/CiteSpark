/** Body sections Citspark manages inside a note (SYN-02, SYN-06). */
export const SECTION_NAMES = ["source", "user", "generated"] as const;
export type SectionName = (typeof SECTION_NAMES)[number];

const MARKER =
  /<!--[ \t]*citspark:(source|user|generated):(begin|end)((?:[ \t]+[^\s>]+)*)[ \t]*-->/g;

export type Segment =
  | { type: "text"; text: string }
  | { type: "section"; name: SectionName; begin: string; text: string; end: string };

/**
 * Parses a body into text outside sections and marked sections. Returns null when the markers are
 * unbalanced, nested, or repeat a section name; callers then merge the body as a whole.
 */
export function parseBody(body: string): Segment[] | null {
  const segments: Segment[] = [];
  const seen = new Set<SectionName>();
  let open: { name: SectionName; begin: string; from: number } | null = null;
  let last = 0;
  for (const m of body.matchAll(MARKER)) {
    const [raw, name, edge] = m as unknown as [string, SectionName, "begin" | "end"];
    const at = m.index;
    if (edge === "begin") {
      if (open || seen.has(name)) return null;
      segments.push({ type: "text", text: body.slice(last, at) });
      open = { name, begin: raw, from: at + raw.length };
      seen.add(name);
    } else {
      if (open?.name !== name) return null;
      segments.push({
        type: "section",
        name,
        begin: open.begin,
        text: body.slice(open.from, at),
        end: raw,
      });
      open = null;
    }
    last = at + raw.length;
  }
  if (open) return null;
  segments.push({ type: "text", text: body.slice(last) });
  return segments;
}

export function renderBody(segments: readonly Segment[]): string {
  return segments.map((s) => (s.type === "text" ? s.text : s.begin + s.text + s.end)).join("");
}

/** Section names in order: two bodies with the same shape merge section by section. */
export function shape(segments: readonly Segment[]): string {
  return segments.map((s) => (s.type === "section" ? s.name : "")).join("|");
}

export function sectionText(segments: readonly Segment[] | null, name: SectionName): string | null {
  const s = segments?.find((x) => x.type === "section" && x.name === name);
  return s ? s.text : null;
}

// Escaping (SYN-06): text Citspark writes into a section must not contain a marker. `<!-- citspark:`
// becomes `&lt;!-- citspark:`, which Markdown renders as the original characters. Text that
// already holds `&lt;!-- citspark:` gains `amp;` (`&amp;lt;...`), and so on, so the mapping is
// reversible.
const ESCAPABLE = /(<|&((?:amp;)*)lt;)!--([ \t]*)citspark:/g;

export function escapeSectionText(text: string): string {
  return text.replace(ESCAPABLE, (_m, lead: string, amps: string | undefined, ws: string) =>
    lead === "<" ? `&lt;!--${ws}citspark:` : `&amp;${amps ?? ""}lt;!--${ws}citspark:`,
  );
}

export function unescapeSectionText(text: string): string {
  return text.replace(/&((?:amp;)*)lt;!--([ \t]*)citspark:/g, (_m, amps: string, ws: string) =>
    amps === "" ? `<!--${ws}citspark:` : `&${amps.slice(4)}lt;!--${ws}citspark:`,
  );
}

export interface RenderSections {
  /** Captured original. `version` is written as `v=` on the begin marker. */
  source?: { text: string; version: string };
  user?: string;
  generated?: string;
}

/** Renders the managed body for a new note, escaping section text (SYN-06). */
export function renderSections(s: RenderSections): string {
  const block = (name: SectionName, text: string, attrs = ""): string =>
    `<!-- citspark:${name}:begin${attrs} -->\n${ensureEol(escapeSectionText(text))}<!-- citspark:${name}:end -->\n`;
  if (s.source && !/^[^\s>]+$/.test(s.source.version)) {
    throw new Error("Source version must be a non-empty token without whitespace or '>'");
  }
  const parts: string[] = [];
  if (s.source) parts.push(block("source", s.source.text, ` v=${s.source.version}`));
  if (s.user !== undefined) parts.push(block("user", s.user));
  if (s.generated !== undefined) parts.push(block("generated", s.generated));
  return parts.join("\n");
}

function ensureEol(t: string): string {
  return t === "" || t.endsWith("\n") ? t : `${t}\n`;
}
