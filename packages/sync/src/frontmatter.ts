import { isDeepStrictEqual } from "node:util";
import YAML from "yaml";
import { merge3Value } from "./merge-text.ts";

/** Frontmatter schema version this build reads and writes (SYN-06). */
export const NOTE_SCHEMA_VERSION = 1;
/** Top-level frontmatter key Citspark owns. Its sub-keys merge individually. */
export const NAMESPACE = "citspark";

export interface SplitNote {
  /** Raw YAML between the `---` fences, or null when the note has no frontmatter. */
  frontmatter: string | null;
  body: string;
}

const FENCE = /^---\n([\s\S]*?\n)?---[ \t]*(?:\n|$)/;

/** Splits LF-normalized note text into raw frontmatter and body. */
export function splitNote(text: string): SplitNote {
  const m = FENCE.exec(text);
  if (!m) return { frontmatter: null, body: text };
  return { frontmatter: m[1] ?? "", body: text.slice(m[0].length) };
}

export function joinNote(frontmatter: string | null, body: string): string {
  if (frontmatter === null) return body;
  const fm = frontmatter === "" || frontmatter.endsWith("\n") ? frontmatter : `${frontmatter}\n`;
  return `---\n${fm}---\n${body}`;
}

type Mapping = Record<string, unknown>;

const dictionary = (): Mapping => Object.create(null) as Mapping;
const own = (map: Mapping, key: string): unknown =>
  Object.hasOwn(map, key) ? map[key] : undefined;

interface Parsed {
  doc: YAML.Document | null;
  /** null when the YAML is not a mapping or does not parse: the block is then compared as text. */
  map: Mapping | null;
}

const PARSE_OPTIONS = { intAsBigInt: true, uniqueKeys: true, prettyErrors: false } as const;

function isMapping(v: unknown): v is Mapping {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parse(raw: string | null): Parsed {
  if (raw === null) return { doc: null, map: {} };
  try {
    const doc = YAML.parseDocument(raw, PARSE_OPTIONS);
    if (doc.errors.length > 0 || doc.warnings.length > 0) return { doc: null, map: null };
    let supported = true;
    YAML.visit(doc, (_key, node) => {
      if (
        YAML.isMap(node) &&
        node.items.some((pair) => !YAML.isScalar(pair.key) || typeof pair.key.value !== "string")
      )
        supported = false;
      if (
        YAML.isNode(node) &&
        node.tag &&
        !/^tag:yaml.org,2002:(?:map|seq|str|null|bool|int|float)$/.test(node.tag)
      )
        supported = false;
    });
    if (!supported) return { doc: null, map: null };
    const js: unknown = doc.toJS({ maxAliasCount: 100 });
    if (js === null || js === undefined) return { doc, map: {} };
    return isMapping(js) ? { doc, map: js } : { doc: null, map: null };
  } catch {
    // Keep parser/conversion limits: unreadable data is reviewed using the raw variants.
    return { doc: null, map: null };
  }
}

/** Reads the `citspark` block from raw frontmatter, or null if absent or unreadable. */
export function readNamespace(raw: string | null): Mapping | null {
  const { map } = parse(raw);
  const ns = map ? own(map, NAMESPACE) : undefined;
  return isMapping(ns) ? ns : null;
}

export interface MetadataConflict {
  kind: "metadata";
  /** Key path, e.g. `["tags"]` or `["citspark", "kind"]`. `["(frontmatter)"]` when unparseable. */
  key: string[];
  base?: unknown;
  vault?: unknown;
  library?: unknown;
}

export type FrontmatterMerge =
  { clean: true; frontmatter: string | null } | { clean: false; conflicts: MetadataConflict[] };

function conflict(
  key: string[],
  base: unknown,
  vault: unknown,
  library: unknown,
): MetadataConflict {
  const c: MetadataConflict = { kind: "metadata", key };
  if (base !== undefined) c.base = base;
  if (vault !== undefined) c.vault = vault;
  if (library !== undefined) c.library = library;
  return c;
}

function mergeMaps(
  path: string[],
  b: Mapping,
  v: Mapping,
  l: Mapping,
  out: Mapping,
  conflicts: MetadataConflict[],
): void {
  const keys = new Set([...Object.keys(v), ...Object.keys(l), ...Object.keys(b)]);
  for (const key of keys) {
    const [bv, vv, lv] = [own(b, key), own(v, key), own(l, key)];
    const nested =
      path.length === 0 &&
      key === NAMESPACE &&
      [bv, vv, lv].every((x) => x === undefined || isMapping(x)) &&
      (vv !== undefined || lv !== undefined);
    if (nested) {
      // A side that removed the whole block removed every sub-key.
      const sub = dictionary();
      mergeMaps(
        [key],
        (bv as Mapping | undefined) ?? {},
        (vv as Mapping | undefined) ?? {},
        (lv as Mapping | undefined) ?? {},
        sub,
        conflicts,
      );
      const removed =
        (vv === undefined && bv !== undefined) || (lv === undefined && bv !== undefined);
      if (Object.keys(sub).length > 0 || !removed) out[key] = sub;
      continue;
    }
    const r = merge3Value(bv, vv, lv, isDeepStrictEqual);
    if (!r.clean) conflicts.push(conflict([...path, key], bv, vv, lv));
    else if (r.value !== undefined) out[key] = r.value;
  }
}

function comments(doc: YAML.Document | null): string[] {
  if (!doc) return [];
  const out: string[] = [];
  const add = (node: { comment?: string | null; commentBefore?: string | null }): void => {
    if (node.comment) out.push(node.comment);
    if (node.commentBefore) out.push(node.commentBefore);
  };
  add(doc);
  YAML.visit(doc, (_key, node) => {
    if (YAML.isNode(node)) add(node);
  });
  return out;
}

function retainsComments(before: string[], after: string[]): boolean {
  const remaining = [...after];
  return before.every((comment) => {
    const at = remaining.indexOf(comment);
    if (at < 0) return false;
    remaining.splice(at, 1);
    return true;
  });
}

/**
 * Per-key three-way merge of YAML frontmatter (SYN-03, SYN-06). Each top-level key, and each
 * sub-key of the `citspark` block, is merged independently. The same key changed differently on
 * both sides is a conflict, never last-write-wins. The vault's formatting and comments are kept
 * for keys whose value does not change.
 */
export function mergeFrontmatter(
  base: string | null,
  vault: string | null,
  library: string | null,
): FrontmatterMerge {
  const [pb, pv, pl] = [parse(base), parse(vault), parse(library)];
  if (pb.map === null || pv.map === null || pl.map === null) {
    return { clean: false, conflicts: [conflict(["(frontmatter)"], base, vault, library)] };
  }
  const included = [pb.map, pv.map, pl.map].some((map) => {
    const ns = own(map, NAMESPACE);
    return isMapping(ns) && own(ns, "managed") === false;
  });
  if (included) {
    const conflicts = [...new Set([...Object.keys(pb.map), ...Object.keys(pl.map)])]
      .filter(
        (key) => key !== NAMESPACE && !isDeepStrictEqual(own(pb.map!, key), own(pl.map!, key)),
      )
      .map((key) => conflict([key], own(pb.map!, key), own(pv.map!, key), own(pl.map!, key)));
    if (conflicts.length > 0) return { clean: false, conflicts };
  }
  if (vault === library || library === base) return { clean: true, frontmatter: vault };
  if (!included && vault === base) return { clean: true, frontmatter: library };
  const merged = dictionary();
  const conflicts: MetadataConflict[] = [];
  mergeMaps([], pb.map, pv.map, pl.map, merged, conflicts);
  if (conflicts.length > 0) return { clean: false, conflicts };
  if (isDeepStrictEqual(merged, pv.map)) return { clean: true, frontmatter: vault };
  const vaultComments = comments(pv.doc);
  const baseComments = comments(pb.doc);
  const addedLibraryComments = comments(pl.doc).filter((comment) => {
    const at = baseComments.indexOf(comment);
    if (at < 0) return true;
    baseComments.splice(at, 1);
    return false;
  });
  try {
    const frontmatter = applyToVault(pv, merged);
    const rendered = parse(frontmatter);
    const renderedComments = comments(rendered.doc);
    if (
      rendered.map === null ||
      // Editing an anchored node can also change aliases outside the owned namespace.
      // Compare values structurally: merge dictionaries deliberately have null prototypes.
      !isDeepStrictEqual(rendered.map, merged, { skipPrototype: true }) ||
      !retainsComments(vaultComments, renderedComments) ||
      !retainsComments(addedLibraryComments, renderedComments)
    ) {
      return { clean: false, conflicts: [conflict(["(frontmatter)"], base, vault, library)] };
    }
    return { clean: true, frontmatter };
  } catch {
    return { clean: false, conflicts: [conflict(["(frontmatter)"], base, vault, library)] };
  }
}

function applyToVault(vault: Parsed, merged: Mapping): string | null {
  const vmap = vault.map ?? {};
  if (Object.keys(merged).length === 0 && vault.doc === null) return null;
  // An empty block may still hold comments, so keep its document and give it a map.
  if (vault.doc && vault.doc.contents === null) {
    (vault.doc as YAML.Document).contents =
      new YAML.YAMLMap() as unknown as YAML.Document["contents"];
  }
  const doc = vault.doc && YAML.isMap(vault.doc.contents) ? vault.doc : new YAML.Document({});
  for (const key of new Set([...Object.keys(vmap), ...Object.keys(merged)])) {
    const [vv, mv] = [own(vmap, key), own(merged, key)];
    if (isDeepStrictEqual(vv, mv)) continue;
    if (mv === undefined) {
      doc.delete(key);
    } else if (isMapping(vv) && isMapping(mv) && YAML.isMap(doc.get(key, true))) {
      for (const sub of new Set([...Object.keys(vv), ...Object.keys(mv)])) {
        if (isDeepStrictEqual(own(vv, sub), own(mv, sub))) continue;
        if (own(mv, sub) === undefined) doc.deleteIn([key, sub]);
        else doc.setIn([key, sub], own(mv, sub));
      }
    } else {
      doc.set(key, mv);
    }
  }
  return doc.toString({ lineWidth: 0 });
}
