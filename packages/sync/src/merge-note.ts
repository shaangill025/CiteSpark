import {
  joinNote,
  mergeFrontmatter,
  NOTE_SCHEMA_VERSION,
  readNamespace,
  splitNote,
  type MetadataConflict,
} from "./frontmatter.ts";
import { merge3, merge3Value, type ConflictHunk } from "./merge-text.ts";
import {
  parseBody,
  renderBody,
  sectionText,
  shape,
  unescapeSectionText,
  type Segment,
} from "./sections.ts";
import { denormalize, normalize } from "./text.ts";

export interface NoteVersions {
  /** Last common revision both sides agreed on (the stored base). */
  base: string;
  /** Current file content in the vault. */
  vault: string;
  /** Current rendering of the note on the library side. */
  library: string;
}

export interface ContentConflict {
  kind: "content";
  /** `source`, `user`, `generated`, `outside:N` (text outside sections), `<name>:marker`, or `body`. */
  section: string;
  hunks: ConflictHunk[];
}

export interface SchemaConflict {
  kind: "schema";
  side: "base" | "vault" | "library";
  version: string;
}

/** The library side changed the body of an included user note, which Citspark never writes. */
export interface ReadOnlyBodyConflict {
  kind: "readonly_body";
}

export type NoteConflict =
  MetadataConflict | ContentConflict | SchemaConflict | ReadOnlyBodyConflict;

/** The vault edited the captured original. It is a user-authored version, not the original (SYN-02). */
export interface SourceEdit {
  text: string;
  libraryText: string;
}

export type NoteMerge =
  | { status: "clean"; text: string; changed: boolean; sourceEdit?: SourceEdit }
  | { status: "conflict"; conflicts: NoteConflict[] };

export interface MergeNoteOptions {
  /**
   * `vault`: the body belongs to the user and Citspark never changes it (included user notes,
   * ADR 0007). Defaults to `vault` when any side has `citspark.managed: false`, else `shared`.
   */
  bodyOwner?: "shared" | "vault";
}

/**
 * Three-way merge of one note (SYN-03, ADR 0007 step 3). Frontmatter merges per key and the body
 * merges per section with diff3. Any conflict returns no text: the caller leaves the vault file
 * untouched and stores all three versions for review. A clean result keeps the vault's BOM and
 * line-ending style.
 */
export function mergeNote(versions: NoteVersions, options: MergeNoteOptions = {}): NoteMerge {
  const forms = {
    base: normalize(versions.base),
    vault: normalize(versions.vault),
    library: normalize(versions.library),
  };
  const split = {
    base: splitNote(forms.base.text),
    vault: splitNote(forms.vault.text),
    library: splitNote(forms.library.text),
  };

  const conflicts: NoteConflict[] = [];
  const namespaces = (["base", "vault", "library"] as const).map((side) => {
    const ns = readNamespace(split[side].frontmatter);
    const v = ns?.["schema"];
    if (
      v !== undefined &&
      !((typeof v === "number" || typeof v === "bigint") && Number(v) <= NOTE_SCHEMA_VERSION)
    ) {
      // YAML collections can shadow coercion methods (including inside sequences).
      const version =
        v === null
          ? "null"
          : typeof v === "object"
            ? Array.isArray(v)
              ? "[sequence]"
              : "[mapping]"
            : String(v);
      conflicts.push({ kind: "schema", side, version });
    }
    return ns;
  });
  if (conflicts.length > 0) return { status: "conflict", conflicts };

  const fm = mergeFrontmatter(
    split.base.frontmatter,
    split.vault.frontmatter,
    split.library.frontmatter,
  );
  if (!fm.clean) conflicts.push(...fm.conflicts);

  const owner =
    options.bodyOwner ?? (namespaces.some((ns) => ns?.["managed"] === false) ? "vault" : "shared");
  const body: BodyMerge =
    owner === "vault"
      ? split.library.body === split.base.body
        ? { body: split.vault.body, conflicts: [] }
        : { conflicts: [{ kind: "readonly_body" }] }
      : mergeBody(split.base.body, split.vault.body, split.library.body);
  conflicts.push(...body.conflicts);

  if (conflicts.length > 0 || !fm.clean || body.body === undefined)
    return { status: "conflict", conflicts };
  const text = denormalize(joinNote(fm.frontmatter, body.body), forms.vault);
  const result: NoteMerge = { status: "clean", text, changed: text !== versions.vault };
  if (body.sourceEdit) result.sourceEdit = body.sourceEdit;
  return result;
}

interface BodyMerge {
  body?: string;
  conflicts: NoteConflict[];
  sourceEdit?: SourceEdit;
}

function sourceText(body: string): string | null {
  // Other damaged sections must not hide an otherwise intact, attributable source block.
  const markers = [
    ...body.matchAll(/<!--[ \t]*citspark:source:(begin|end)((?:[ \t]+[^\s>]+)*)[ \t]*-->/g),
  ];
  const [begin, end] = markers;
  if (markers.length !== 2 || begin?.[1] !== "begin" || end?.[1] !== "end") return null;
  return sectionText(parseBody(body.slice(begin.index, end.index + end[0].length)), "source");
}

function mergeBody(base: string, vault: string, library: string): BodyMerge {
  const [pb, pv, pl] = [parseBody(base), parseBody(vault), parseBody(library)];
  const sources = [sourceText(base), sourceText(vault), sourceText(library)];
  if (sources.some((s) => s !== null) && sources.some((s) => s === null)) {
    return {
      conflicts: [
        {
          kind: "content",
          section: "source:marker",
          hunks: [{ baseLine: 0, base, vault, library }],
        },
      ],
    };
  }
  const merged =
    pb && pv && pl && shape(pb) === shape(pv) && shape(pv) === shape(pl)
      ? mergeSegments(pb, pv, pl)
      : wholeBody(base, vault, library);
  if (merged.body === undefined) return merged;
  const mine = sourceText(merged.body);
  const theirs = sourceText(library);
  // The library renders the immutable capture, so a merge never changes the vault's source text
  // (see mergeSegments). The whole-body fallback cannot tell a stale capture from a deletion of
  // earlier user text, so any change it makes there is kept for review instead.
  if (sources[1] !== null && mine !== sources[1]) {
    return {
      conflicts: [
        { kind: "content", section: "source", hunks: [{ baseLine: 0, base, vault, library }] },
      ],
    };
  }
  if (mine !== null && theirs !== null && mine !== theirs) {
    merged.sourceEdit = {
      text: unescapeSectionText(mine),
      libraryText: unescapeSectionText(theirs),
    };
  }
  return merged;
}

function wholeBody(base: string, vault: string, library: string): BodyMerge {
  const r = merge3(base, vault, library);
  return r.clean
    ? { body: r.text, conflicts: [] }
    : { conflicts: [{ kind: "content", section: "body", hunks: r.hunks }] };
}

type SectionSeg = Extract<Segment, { type: "section" }>;

function mergeSegments(b: Segment[], v: Segment[], l: Segment[]): BodyMerge {
  const out: Segment[] = [];
  const conflicts: NoteConflict[] = [];
  const text = (label: string, x: string, y: string, z: string): string => {
    const r = merge3(x, y, z);
    if (r.clean) return r.text;
    conflicts.push({ kind: "content", section: label, hunks: r.hunks });
    return y;
  };
  const marker = (label: string, x: string, y: string, z: string): string => {
    const r = merge3Value(x, y, z, (p, q) => p === q);
    if (r.clean) return r.value;
    conflicts.push({
      kind: "content",
      section: `${label}:marker`,
      hunks: [{ baseLine: 0, base: x, vault: y, library: z }],
    });
    return y;
  };
  // SYN-02: the library always renders the immutable capture named by the begin marker. Once a
  // user version of the source becomes the base, the library's text differs from the base only
  // because the base holds earlier user text, so diff3 would read the capture as a deletion of
  // it. With a stable marker the library proposes no source change and the vault's text stands.
  // A new capture version applies cleanly only when it leaves the vault's text intact (same text
  // as base or vault); otherwise the base may hold user text, so all three are kept for review.
  const source = (sb: SectionSeg, sv: SectionSeg, sl: SectionSeg): string => {
    if (sb.begin === sl.begin || sl.text === sb.text || sl.text === sv.text) return sv.text;
    conflicts.push({
      kind: "content",
      section: "source",
      hunks: [{ baseLine: 0, base: sb.text, vault: sv.text, library: sl.text }],
    });
    return sv.text;
  };
  for (let i = 0; i < v.length; i++) {
    const [sb, sv, sl] = [b[i], v[i], l[i]];
    if (sb?.type === "section" && sv?.type === "section" && sl?.type === "section") {
      out.push({
        type: "section",
        name: sv.name,
        begin: marker(sv.name, sb.begin, sv.begin, sl.begin),
        text: sv.name === "source" ? source(sb, sv, sl) : text(sv.name, sb.text, sv.text, sl.text),
        end: marker(sv.name, sb.end, sv.end, sl.end),
      });
    } else if (sb?.type === "text" && sv?.type === "text" && sl?.type === "text") {
      out.push({ type: "text", text: text(`outside:${i}`, sb.text, sv.text, sl.text) });
    } else {
      throw new Error("mergeSegments called with differently shaped bodies");
    }
  }
  return conflicts.length > 0 ? { conflicts } : { body: renderBody(out), conflicts };
}
