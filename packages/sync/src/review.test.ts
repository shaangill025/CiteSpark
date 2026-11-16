import { describe, expect, it } from "vitest";
import { joinNote, mergeFrontmatter, readNamespace, splitNote } from "./frontmatter.ts";
import { mergeNote } from "./merge-note.ts";
import { parseBody, renderSections, sectionText } from "./sections.ts";

import { identify } from "./identity.ts";

it("does not revert source user-text through whole-body fallback or a capture-marker change", () => {
  const original = renderSections({
    source: { text: "original\n", version: "v1" },
    generated: "ai\n",
  });
  const edited = original.replace("original", "user version");
  for (const versions of [
    {
      base: edited,
      vault: edited.replace("<!-- citspark:generated:end -->", ""),
      library: original,
    },
    { base: edited, vault: edited, library: original.replace("v=v1", "v=v2") },
  ]) {
    expect(mergeNote(versions).status).toBe("conflict");
  }
});

it("conflicts on unsupported YAML tags rather than dropping their semantics", () => {
  for (const value of ["!custom old", "!!set { old: null }", "!!omap [old: value]"]) {
    const base = `custom: ${value}\nother: base\n`;
    expect(
      mergeFrontmatter(
        base,
        base.replace("other: base", "other: vault"),
        base.replace("old", "new"),
      ).clean,
    ).toBe(false);
  }
});

it("rejects non-string YAML mapping keys instead of writing duplicate stringified keys", () => {
  for (const key of ["1", "true", "null", "[a, b]"]) {
    for (const nested of [false, true]) {
      const content = nested ? `custom:\n  ${key}: old\n` : `${key}: old\n`;
      const base = content + "other: base\n";
      const vault = base.replace("other: base", "other: vault");
      const library = base.replace("old", "new");
      expect(mergeFrontmatter(base, vault, library).clean).toBe(false);
      expect(mergeFrontmatter(base, base, library).clean).toBe(false);
    }
  }
});

it("keeps ambiguous hash bindings in review instead of declaring deletion", () => {
  for (const libraryChanged of [false, true]) {
    for (const manyBindings of [false, true]) {
      const files = manyBindings
        ? [{ path: "x.md", id: null, hash: "same" }]
        : [
            { path: "x.md", id: null, hash: "same" },
            { path: "y.md", id: null, hash: "same" },
          ];
      const bindings = (manyBindings ? ["A", "B"] : ["A"]).map((noteId) => ({
        noteId,
        path: `${noteId}.md`,
        state: "bound" as const,
        baseHash: "same",
        libraryChanged,
      }));
      const decisions = identify(files, bindings);
      expect(decisions.some((d) => d.type === "deleted" || d.type === "delete_vs_edit")).toBe(
        false,
      );
      for (const binding of bindings)
        expect(decisions).toContainEqual({
          type: "ambiguous_hash",
          noteId: binding.noteId,
          path: binding.path,
          paths: files.map((f) => f.path),
        });
    }
  }
});

it("keeps a source user-version on subsequent syncs against the immutable original", () => {
  const original = renderSections({
    source: { text: "original\n", version: "v1" },
    user: "user\n",
  });
  const edited = original.replace("original", "user version");
  const first = mergeNote({ base: original, vault: edited, library: original });
  expect(first.status).toBe("clean");
  if (first.status !== "clean") return;
  const next = mergeNote({ base: first.text, vault: first.text, library: original });
  expect(next).toMatchObject({
    status: "clean",
    text: edited,
    changed: false,
    sourceEdit: { text: "\nuser version\n", libraryText: "\noriginal\n" },
  });
});

it("does not silently discard new library comments during concurrent metadata edits", () => {
  const base = "tags: [a]\nother: base\n";
  const vault = base.replace("other: base", "other: vault");
  const library = "tags:\n  - a # new user explanation\nother: base\n";
  const result = mergeFrontmatter(base, vault, library);
  expect(result.clean && !result.frontmatter?.includes("# new user explanation")).toBe(false);
});

it("never silently drops comments when replacing nested mappings or lists", () => {
  for (const collection of [
    "settings:\n  nested:\n    value: old # user explanation\n",
    "tags:\n  - old # user explanation\n",
  ]) {
    const base = collection + "other: base\n";
    const vault = base.replace("other: base", "other: vault");
    const library = base.replace("old", "new");
    for (const mine of [vault, base]) {
      const result = mergeFrontmatter(base, mine, library);
      expect(result.clean && !result.frontmatter?.includes("# user explanation")).toBe(false);
    }
  }
});

it("refuses library mutations of unrelated metadata in included user notes", () => {
  const meta = "citspark:\n  schema: 1\n  managed: false\n  kind: user_note\n";
  const base = joinNote(meta + "custom: original\n", "body");
  const library = joinNote(meta + "custom: replaced\n", "body");
  expect(mergeNote({ base, vault: base, library })).toMatchObject({
    status: "conflict",
    conflicts: [{ kind: "metadata", key: ["custom"] }],
  });
});

it("conflicts when a source edit loses its closing marker", () => {
  const base = renderSections({ source: { text: "original\n", version: "v1" }, user: "user\n" });
  const vault = base.replace("original", "edited").replace("<!-- citspark:source:end -->", "");
  const result = mergeNote({ base, vault, library: base });
  expect(result).toMatchObject({
    status: "conflict",
    conflicts: [{ kind: "content", section: "source:marker" }],
  });
});
import YAML from "yaml";
import Database from "better-sqlite3";
import { migrate } from "@citspark/store";
import { listConflicts, mergeConflictRecord, recordConflict } from "./persistence.ts";

it("persists recursive YAML conflict details with every raw variant intact", () => {
  const versions = {
    base: joinNote("a: &x [*x]\n", ""),
    vault: joinNote("a: &x [*x, v]\n", ""),
    library: joinNote("a: &x [*x, l]\n", ""),
  };
  const result = mergeNote(versions);
  expect(result.status).toBe("conflict");
  if (result.status !== "conflict") return;
  const db = new Database(":memory:");
  try {
    migrate(db);
    recordConflict(
      db,
      mergeConflictRecord(
        { libraryId: "lib", vaultId: "vault", noteId: "n" },
        "n.md",
        versions,
        result.conflicts,
      ),
    );
    const [saved] = listConflicts(db, "lib", "vault");
    expect(saved).toMatchObject(versions);
    expect(JSON.stringify(saved?.details)).toContain("[Circular]");
    expect(JSON.stringify(saved?.details)).toContain('"v"');
    expect(JSON.stringify(saved?.details)).toContain('"l"');
  } finally {
    db.close();
  }
});

it("merges prototype-named YAML keys as own data at both namespace levels", () => {
  for (const key of ["__proto__", "constructor", "toString"]) {
    for (const nested of [false, true]) {
      const wrap = (s: string): string =>
        nested
          ? `citspark:\n${s
              .split("\n")
              .filter(Boolean)
              .map((x) => `  ${x}\n`)
              .join("")}`
          : s;
      for (const libraryAdds of [false, true]) {
        const base = wrap("a: 1\n");
        const addition = wrap(`a: 1\n${key}: mine\n`);
        const change = wrap("a: 2\n");
        const result = mergeFrontmatter(
          base,
          libraryAdds ? change : addition,
          libraryAdds ? addition : change,
        );
        expect(result.clean).toBe(true);
        if (result.clean) {
          const parsed = YAML.parse(result.frontmatter ?? "") as Record<string, unknown>;
          const map = (nested ? parsed["citspark"] : parsed) as Record<string, unknown>;
          expect(Object.hasOwn(map, key)).toBe(true);
          expect(map[key]).toBe("mine");
          expect(map["a"]).toBe(2);
        }
      }
    }
  }
});

it("conflicts rather than mutating custom aliases of the owned namespace (SYN-03, SYN-06)", () => {
  const base = "citspark: &ns\n  managed: false\n  kind: user_note\ncustom: *ns\nother: base\n";
  const vault = base.replace("other: base", "other: vault");
  const library =
    "citspark:\n  managed: false\n  kind: annotation\ncustom:\n  managed: false\n  kind: user_note\nother: base\n";
  expect(mergeFrontmatter(base, vault, library)).toEqual({
    clean: false,
    conflicts: [{ kind: "metadata", key: ["(frontmatter)"], base, vault, library }],
  });
});

it("compares rendered YAML structurally across mappings, sequences, nulls and prototype keys", () => {
  const base =
    "citspark:\n  managed: false\n  kind: user_note\ncustom: [{__proto__: null, constructor: [null], toString: data}]\nother: base\n";
  const vault = base.replace("other: base", "other: vault");
  const library = base.replace("kind: user_note", "kind: annotation");
  const result = mergeFrontmatter(base, vault, library);
  expect(result.clean).toBe(true);
  if (result.clean) {
    expect(YAML.parse(result.frontmatter ?? "")).toEqual(
      YAML.parse(vault.replace("kind: user_note", "kind: annotation")),
    );
  }
});

it("detects collateral anchor mutations through sequences and prototype-named keys", () => {
  for (const custom of ["custom: [*ns, null]", "__proto__: *ns"]) {
    const base = `citspark: &ns\n  managed: false\n  kind: user_note\n${custom}\nother: base\n`;
    const vault = base.replace("other: base", "other: vault");
    const library = base
      .replace("citspark: &ns", "citspark:")
      .replace("kind: user_note", "kind: annotation")
      .replace("*ns", "{managed: false, kind: user_note}");
    expect(mergeFrontmatter(base, vault, library)).toEqual({
      clean: false,
      conflicts: [{ kind: "metadata", key: ["(frontmatter)"], base, vault, library }],
    });
  }
});

it("returns schema conflicts for collections without coercing YAML objects (SYN-06)", () => {
  for (const [schema, version] of [
    ["{toString: nope}", "[mapping]"],
    ["{__proto__: null, constructor: nope, toString: nope}", "[mapping]"],
    ["[{toString: nope}]", "[sequence]"],
    ["null", "null"],
  ]) {
    const text = `---\ncitspark:\n  schema: ${schema}\n---\nbody`;
    expect(mergeNote({ base: text, vault: text, library: text })).toEqual({
      status: "conflict",
      conflicts: ["base", "vault", "library"].map((side) => ({
        kind: "schema",
        side,
        version,
      })),
    });
  }
});

it("reports alias resource-limit failures as metadata conflicts, never throws", () => {
  const bomb =
    "a: &a [x, x, x, x, x, x, x, x, x, x]\nb: &b [*a, *a, *a, *a, *a, *a, *a, *a, *a, *a]\nc: [*b, *b, *b, *b, *b, *b, *b, *b, *b, *b]\n";
  expect(readNamespace(bomb)).toBeNull();
  for (const versions of [
    { base: "a: 1\n", vault: bomb, library: "a: 2\n" },
    { base: "a: 1\n", vault: bomb, library: "a: 1\n" },
  ]) {
    const notes = Object.fromEntries(
      Object.entries(versions).map(([k, v]) => [k, joinNote(v, "body")]),
    ) as { base: string; vault: string; library: string };
    expect(mergeNote(notes).status).toBe("conflict");
    expect(mergeFrontmatter(versions.base, versions.vault, versions.library).clean).toBe(false);
  }
});

describe("source section across sync rounds (SYN-02 immutable library rendering)", () => {
  const fm =
    "citspark:\n  schema: 1\n  id: 01J9Z3S7M8Q4V6X2B5N0C1D7EF\n  kind: source\n  managed: true\n";
  const original = { text: "l1\nl2\nl3\nl4\nl5\n", version: "v1" };
  const library = joinNote(fm, renderSections({ source: original, user: "u\n", generated: "g\n" }));
  const round1 = (): string => {
    const r = mergeNote({ base: library, vault: library.replace("l1\n", "l1\nmine1\n"), library });
    if (r.status !== "clean") throw new Error("round 1 must merge cleanly");
    return r.text;
  };
  const sourceOf = (text: string): string | null =>
    sectionText(parseBody(splitNote(text).body), "source");

  it("keeps an earlier source edit when the vault edits the source section again", () => {
    const base = round1();
    for (const vault of [
      base.replace("l4\n", "l4\nmine2\n"),
      base.replace("l4\n", ""),
      base.replace("l1\nmine1\n", "l1\nmine1 reworded\n"),
      base.replace("u\n", "u\nmore\n"),
    ]) {
      const r = mergeNote({ base, vault, library });
      expect(r.status).toBe("clean");
      if (r.status !== "clean") continue;
      expect(r.text).toBe(vault);
      expect(r.changed).toBe(false);
      expect(r.sourceEdit).toEqual({ text: sourceOf(vault), libraryText: sourceOf(library) });
    }
  });

  it("applies library changes elsewhere while keeping both rounds of source edits", () => {
    const base = round1();
    const vault = base.replace("l4\n", "l4\nmine2\n");
    const lib = library.replace("g\n", "g2\n");
    const r = mergeNote({ base, vault, library: lib });
    expect(r).toMatchObject({ status: "clean", text: vault.replace("g\n", "g2\n") });
  });

  it("honors the user's own removal of an earlier source edit", () => {
    const base = round1();
    const r = mergeNote({ base, vault: library, library });
    expect(r).toMatchObject({ status: "clean", text: library, changed: false });
    expect(r.status === "clean" && r.sourceEdit).toBeFalsy();
  });

  it("never drops an earlier source edit through the whole-body fallback", () => {
    const base = round1();
    const vault = base
      .replace("l4\n", "l4\nmine2\n")
      .replace("<!-- citspark:generated:end -->\n", "");
    for (const lib of [library, library.replace("g\n", "g2\n")]) {
      const r = mergeNote({ base, vault, library: lib });
      // Losing either round of user text is never acceptable; a conflict keeps all raw variants.
      if (r.status === "clean") {
        expect(r.text).toContain("mine1");
        expect(r.text).toContain("mine2");
      }
    }
  });

  it("conflicts when a new capture version meets a vault source edit, keeping all raw text", () => {
    const base = round1();
    const vault = base.replace("l4\n", "l4\nmine2\n");
    const recaptured = joinNote(
      fm,
      renderSections({
        source: { text: "n1\nn2\n", version: "v2" },
        user: "u\n",
        generated: "g\n",
      }),
    );
    const r = mergeNote({ base, vault, library: recaptured });
    expect(r).toMatchObject({
      status: "conflict",
      conflicts: [{ kind: "content", section: "source" }],
    });
  });

  it("applies a capture-version relabel with unchanged original text and keeps vault edits", () => {
    const vault = library.replace("l1\n", "l1\nmine1\n");
    const relabeled = library.replace("v=v1", "v=v2");
    const r = mergeNote({ base: library, vault, library: relabeled });
    expect(r).toMatchObject({ status: "clean", text: vault.replace("v=v1", "v=v2") });
  });
});

it("keeps the vault frontmatter text verbatim when the merge equals the vault values", () => {
  const vault = "tags: [a]\nx: 2\n";
  expect(mergeFrontmatter("tags: [a]\nx: 1\n", vault, "tags:   [a]\nx: 2\n")).toEqual({
    clean: true,
    frontmatter: vault,
  });
});
