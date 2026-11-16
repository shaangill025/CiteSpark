// T04 property tests (M2-04): random concurrent edit sequences never lose user text, and the same
// metadata key changed on both sides is always a conflict. Vault edits reach the source section
// across rounds while the library keeps rendering the immutable original. Seeded so every CI OS runs the same
// cases. Set T04_RUNS to run more cases locally.
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { joinNote, splitNote } from "./frontmatter.ts";
import { mergeNote } from "./merge-note.ts";
import { merge3 } from "./merge-text.ts";
import { parseBody, renderSections, sectionText } from "./sections.ts";
import { splitLines } from "./text.ts";

const RUNS = Number(process.env["T04_RUNS"] ?? 400);
const params = (numRuns = RUNS): fc.Parameters<unknown> => ({ seed: 0x7404, numRuns });

// ---------- line level ----------

type LineOp = { kind: "ins" | "del" | "rep"; pos: number; count: number };
const lineOp = fc.record({
  kind: fc.constantFrom("ins", "del", "rep"),
  pos: fc.nat(1000),
  count: fc.integer({ min: 1, max: 3 }),
}) as fc.Arbitrary<LineOp>;

function applyLineOps(
  lines: string[],
  ops: readonly LineOp[],
  side: string,
): { lines: string[]; inserted: string[] } {
  const out = [...lines];
  const inserted: string[] = [];
  let n = 0;
  const fresh = (): string => {
    const t = `${side}${n++}\n`;
    inserted.push(t);
    return t;
  };
  for (const op of ops) {
    if (op.kind === "ins") {
      out.splice(op.pos % (out.length + 1), 0, ...Array.from({ length: op.count }, fresh));
    } else if (out.length > 0) {
      const at = op.pos % out.length;
      out.splice(at, 1, ...(op.kind === "rep" ? [fresh()] : []));
    }
  }
  return { lines: out, inserted };
}

const restrictTo = (lines: string[], keep: Set<string>): string[] =>
  lines.filter((l) => keep.has(l));

describe("T04 line-level diff3 properties", () => {
  it("clean merges keep every insertion, apply every deletion, and keep each side's order", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 15 }),
        fc.array(lineOp, { maxLength: 6 }),
        fc.array(lineOp, { maxLength: 6 }),
        (n, vOps, lOps) => {
          const base = Array.from({ length: n }, (_, i) => `base${i}\n`);
          const v = applyLineOps(base, vOps, "v");
          const l = applyLineOps(base, lOps, "l");
          const [bt, vt, lt] = [base.join(""), v.lines.join(""), l.lines.join("")];
          const r = merge3(bt, vt, lt);
          if (!r.clean) {
            expect(r.hunks.length).toBeGreaterThan(0);
            return;
          }
          const merged = splitLines(r.text);
          const set = new Set(merged);
          for (const t of [...v.inserted, ...l.inserted]) {
            if (v.lines.includes(t) || l.lines.includes(t)) expect(set.has(t)).toBe(true);
          }
          for (const b of base) {
            const deleted = !v.lines.includes(b) || !l.lines.includes(b);
            expect(set.has(b)).toBe(!deleted);
          }
          expect(merged).toHaveLength(set.size);
          expect(restrictTo(merged, new Set(v.lines))).toEqual(restrictTo(v.lines, set));
          expect(restrictTo(merged, new Set(l.lines))).toEqual(restrictTo(l.lines, set));
        },
      ),
      params(),
    );
  });

  it("clean merges keep every inserted line even with repeated base lines", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("\n", "x\n", "- \n", "# h\n"), { maxLength: 15 }),
        fc.array(lineOp, { maxLength: 6 }),
        fc.array(lineOp, { maxLength: 6 }),
        (base, vOps, lOps) => {
          const v = applyLineOps(base, vOps, "v");
          const l = applyLineOps(base, lOps, "l");
          const r = merge3(base.join(""), v.lines.join(""), l.lines.join(""));
          if (!r.clean) return;
          const set = new Set(splitLines(r.text));
          for (const t of [...v.lines, ...l.lines].filter((x) => /^[vl]\d/.test(x)))
            expect(set.has(t)).toBe(true);
        },
      ),
      params(),
    );
  });

  it("conflict hunks hold each side's text verbatim", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10 }),
        fc.array(lineOp, { maxLength: 5 }),
        fc.array(lineOp, { maxLength: 5 }),
        (n, vOps, lOps) => {
          const base = Array.from({ length: n }, (_, i) => `base${i}\n`);
          const [vt, lt] = [
            applyLineOps(base, vOps, "v").lines.join(""),
            applyLineOps(base, lOps, "l").lines.join(""),
          ];
          const r = merge3(base.join(""), vt, lt);
          if (r.clean) return;
          for (const h of r.hunks) {
            expect(vt.includes(h.vault)).toBe(true);
            expect(lt.includes(h.library)).toBe(true);
            expect(h.vault).not.toBe(h.library);
          }
        },
      ),
      params(),
    );
  });
});

// ---------- note level, multi-round ----------

const KEYS = ["m0", "m1", "m2"] as const;
type VaultOp = {
  kind:
    | "user-ins"
    | "user-del"
    | "user-rep"
    | "src-ins"
    | "src-del"
    | "src-rep"
    | "src-orig"
    | "outside"
    | "meta";
  pos: number;
  key: number;
  drop: boolean;
};
type LibOp = {
  kind: "gen-ins" | "gen-del" | "user-ins" | "meta";
  pos: number;
  key: number;
  drop: boolean;
};
const common = { pos: fc.nat(1000), key: fc.nat(KEYS.length - 1), drop: fc.boolean() };
const vaultOp = fc.record({
  kind: fc.constantFrom(
    "user-ins",
    "user-del",
    "user-rep",
    "src-ins",
    "src-del",
    "src-rep",
    "src-orig",
    "outside",
    "meta",
  ),
  ...common,
}) as fc.Arbitrary<VaultOp>;
const libOp = fc.record({
  kind: fc.constantFrom("gen-ins", "gen-del", "user-ins", "meta"),
  ...common,
}) as fc.Arbitrary<LibOp>;
const round = fc.record({
  vault: fc.array(vaultOp, { maxLength: 4 }),
  library: fc.array(libOp, { maxLength: 4 }),
  /** How the user resolves a conflict in review: keep the vault or the library variant. */
  keepVault: fc.boolean(),
});

const TOKEN = /^t[vl]\d+\n$/;

class Side {
  private n = 0;
  constructor(
    private readonly prefix: string,
    readonly inserted: Set<string>,
    readonly deleted: Set<string>,
  ) {}

  private token(): string {
    const t = `t${this.prefix}${this.n++}\n`;
    this.inserted.add(t);
    return t;
  }

  private region(lines: string[], name: string): [number, number] {
    const b = lines.findIndex((l) => l.includes(`citspark:${name}:begin`));
    const e = lines.findIndex((l) => l.includes(`citspark:${name}:end`));
    return [b + 1, e];
  }

  insert(text: string, name: string, pos: number): string {
    const lines = splitLines(text);
    const [from, to] = this.region(lines, name);
    lines.splice(from + (pos % (to - from + 1)), 0, this.token());
    return lines.join("");
  }

  remove(text: string, name: string, pos: number, replace: boolean): string {
    const lines = splitLines(text);
    const [from, to] = this.region(lines, name);
    const tokens = lines
      .map((l, i) => [l, i] as const)
      .filter(([l, i]) => i >= from && i < to && TOKEN.test(l));
    const pick = tokens[pos % Math.max(tokens.length, 1)];
    if (!pick) return text;
    this.deleted.add(pick[0]);
    lines.splice(pick[1], 1, ...(replace ? [this.token()] : []));
    return lines.join("");
  }

  append(text: string): string {
    return text + this.token();
  }

  meta(text: string, key: string, drop: boolean): string {
    const { frontmatter, body } = splitNote(text);
    const doc = YAML.parseDocument(frontmatter ?? "");
    if (drop) doc.delete(key);
    else doc.set(key, `${this.prefix}${this.n++}`);
    return joinNote(doc.toString(), body);
  }
}

const meta = (text: string): Record<string, unknown> =>
  (YAML.parse(splitNote(text).frontmatter ?? "") ?? {}) as Record<string, unknown>;
const tokens = (text: string): Set<string> =>
  new Set(splitLines(text).filter((l) => TOKEN.test(l)));

const ORIGINAL = "captured original\n";

/** The library always renders the immutable captured original in the source section (SYN-02). */
function libraryRendering(text: string): string {
  const lines = splitLines(text);
  const b = lines.findIndex((l) => l.includes("citspark:source:begin"));
  const e = lines.findIndex((l) => l.includes("citspark:source:end"));
  lines.splice(b + 1, e - b - 1, ORIGINAL);
  return lines.join("");
}

const sourceOf = (text: string): string | null =>
  sectionText(parseBody(splitNote(text).body), "source");

function initialNote(): string {
  const fm =
    "citspark:\n  schema: 1\n  id: 01J9Z3S7M8Q4V6X2B5N0C1D7EF\n  kind: source\n  managed: true\nm0: a\nm1: b\nm2: c\n";
  const body = renderSections({
    source: { text: ORIGINAL, version: "01J9" },
    user: "",
    generated: "",
  });
  return `---\n${fm}---\nintro\n${body}`;
}

describe("T04 note-level concurrent edit sequences", () => {
  it("never lose user text, and same-key metadata changes always conflict", () => {
    fc.assert(
      fc.property(fc.array(round, { minLength: 1, maxLength: 6 }), (rounds) => {
        const inserted = new Set<string>();
        const deleted = new Set<string>();
        const vs = new Side("v", inserted, deleted);
        const ls = new Side("l", inserted, deleted);
        let base = initialNote();
        let vault = base;
        let library = base;

        for (const r of rounds) {
          for (const op of r.vault) {
            if (op.kind === "user-ins") vault = vs.insert(vault, "user", op.pos);
            else if (op.kind === "user-del" || op.kind === "user-rep")
              vault = vs.remove(vault, "user", op.pos, op.kind === "user-rep");
            else if (op.kind === "src-ins") vault = vs.insert(vault, "source", op.pos);
            else if (op.kind === "src-del" || op.kind === "src-rep")
              vault = vs.remove(vault, "source", op.pos, op.kind === "src-rep");
            else if (op.kind === "src-orig") vault = vault.replace(ORIGINAL, "");
            else if (op.kind === "outside") vault = vs.append(vault);
            else vault = vs.meta(vault, KEYS[op.key] ?? "m0", op.drop);
          }
          for (const op of r.library) {
            if (op.kind === "gen-ins") library = ls.insert(library, "generated", op.pos);
            else if (op.kind === "gen-del")
              library = ls.remove(library, "generated", op.pos, false);
            else if (op.kind === "user-ins") library = ls.insert(library, "user", op.pos);
            else library = ls.meta(library, KEYS[op.key] ?? "m0", op.drop);
          }

          const [mb, mv, ml] = [meta(base), meta(vault), meta(library)];
          const sameKey = KEYS.some((k) => mv[k] !== mb[k] && ml[k] !== mb[k] && mv[k] !== ml[k]);
          const result = mergeNote({ base, vault, library });

          if (sameKey) expect(result.status).toBe("conflict");
          if (result.status === "conflict") {
            if (sameKey) {
              expect(result.conflicts.some((c) => c.kind === "metadata")).toBe(true);
            }
            // Review resolution: the discarded side's unsynced tokens are deliberately dropped.
            const kept = r.keepVault ? vault : library;
            const keptTokens = tokens(kept);
            for (const t of tokens(r.keepVault ? library : vault))
              if (!keptTokens.has(t)) deleted.add(t);
            for (const t of keptTokens) deleted.delete(t);
            base = vault = kept;
            library = libraryRendering(kept);
          } else {
            const merged = result.text;
            expect(parseBody(splitNote(merged).body)).not.toBeNull();
            const live = new Set([...inserted].filter((t) => !deleted.has(t)));
            expect(tokens(merged)).toEqual(live);
            const mm = meta(merged);
            for (const k of KEYS) expect(mm[k]).toEqual(mv[k] !== mb[k] ? mv[k] : ml[k]);
            // The library never proposes source changes, so the merged source is the vault's,
            // reported as a user-authored version whenever it differs from the original.
            const mine = sourceOf(vault);
            expect(sourceOf(merged)).toBe(mine);
            expect(result.sourceEdit?.text).toBe(mine === sourceOf(library) ? undefined : mine);
            base = vault = merged;
            library = libraryRendering(merged);
          }
        }
      }),
      params(Math.max(50, Math.floor(RUNS / 2))),
    );
  });
});
