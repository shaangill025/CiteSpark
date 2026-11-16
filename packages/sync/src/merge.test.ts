import { describe, expect, it } from "vitest";
import { mergeFrontmatter } from "./frontmatter.ts";
import { mergeNote } from "./merge-note.ts";
import { merge3 } from "./merge-text.ts";
import { escapeSectionText, parseBody, renderSections, unescapeSectionText } from "./sections.ts";

const fm = (yaml: string, body: string): string => `---\n${yaml}---\n${body}`;
const ID =
  "citspark:\n  schema: 1\n  id: 01J9Z3S7M8Q4V6X2B5N0C1D7EF\n  kind: source\n  managed: true\n";
const body = (user: string, generated = "ai\n"): string =>
  renderSections({ source: { text: "original\n", version: "01J9" }, user, generated });

describe("merge3", () => {
  it("merges edits on different lines and conflicts on the same line", () => {
    expect(merge3("a\nb\nc\n", "A\nb\nc\n", "a\nb\nC\n")).toEqual({
      clean: true,
      text: "A\nb\nC\n",
    });
    const r = merge3("a\nb\nc\n", "a\nX\nc\n", "a\nY\nc\n");
    expect(r).toEqual({
      clean: false,
      hunks: [{ baseLine: 1, base: "b\n", vault: "X\n", library: "Y\n" }],
    });
  });

  it("treats the same change on both sides as clean", () => {
    expect(merge3("a\n", "b\n", "b\n")).toEqual({ clean: true, text: "b\n" });
  });
});

describe("mergeFrontmatter (SYN-03)", () => {
  it("merges different keys and keeps vault comments and formatting", () => {
    const base = "title: T\ntags: [a]\n";
    const vault = "# my note\ntitle: 'T2'\ntags: [a]\n";
    const library = "title: T\ntags: [a, b]\n";
    const r = mergeFrontmatter(base, vault, library);
    expect(r).toEqual({
      clean: true,
      frontmatter: "# my note\ntitle: 'T2'\ntags:\n  - a\n  - b\n",
    });
  });

  it("conflicts when both sides change the same key differently", () => {
    const r = mergeFrontmatter("title: T\n", "title: V\n", "title: L\n");
    expect(r).toEqual({
      clean: false,
      conflicts: [{ kind: "metadata", key: ["title"], base: "T", vault: "V", library: "L" }],
    });
  });

  it("conflicts on delete versus change of the same key", () => {
    const r = mergeFrontmatter("a: 1\nb: 2\n", "b: 2\n", "a: 3\nb: 2\n");
    expect(r.clean).toBe(false);
  });

  it("merges citspark sub-keys individually", () => {
    const base = "citspark:\n  kind: source\n  managed: true\n";
    const vault = "citspark:\n  kind: annotation\n  managed: true\n";
    const library = "citspark:\n  kind: source\n  managed: false\n";
    const r = mergeFrontmatter(base, vault, library);
    expect(r).toEqual({
      clean: true,
      frontmatter: "citspark:\n  kind: annotation\n  managed: false\n",
    });
  });

  it("keeps 19-digit integers exact", () => {
    const r = mergeFrontmatter("a: 1\n", "a: 1\nn: 1849302746150912345\n", "a: 2\n");
    expect(r).toEqual({ clean: true, frontmatter: "a: 2\nn: 1849302746150912345\n" });
  });

  it("treats unparseable YAML changed on both sides as a conflict", () => {
    const r = mergeFrontmatter("a: 1\n", "a: [\n", "a: 2\n");
    expect(r.clean).toBe(false);
  });

  it("adds a frontmatter block when the vault had none", () => {
    expect(mergeFrontmatter(null, null, "a: 1\n")).toEqual({ clean: true, frontmatter: "a: 1\n" });
    expect(mergeFrontmatter("a: 1\n", null, "a: 1\nb: 2\n")).toEqual({
      clean: true,
      frontmatter: "b: 2\n",
    });
  });
});

describe("sections (SYN-06)", () => {
  it("parses markers and rejects unbalanced or repeated ones", () => {
    const segs = parseBody(body("mine\n"));
    expect(
      segs?.filter((s) => s.type === "section").map((s) => s.type === "section" && s.name),
    ).toEqual(["source", "user", "generated"]);
    expect(parseBody("<!-- citspark:user:begin -->x")).toBeNull();
    expect(parseBody("<!-- citspark:user:begin --><!-- citspark:source:end -->")).toBeNull();
    expect(
      parseBody(
        "<!-- citspark:user:begin --><!-- citspark:user:end --><!-- citspark:user:begin --><!-- citspark:user:end -->",
      ),
    ).toBeNull();
  });

  it("escapes markers inside section text reversibly", () => {
    for (const t of [
      "<!-- citspark:user:end -->",
      "&lt;!-- citspark:x",
      "&amp;lt;!--  citspark:y",
      "plain & <b>",
    ]) {
      const e = escapeSectionText(t);
      expect(e).not.toMatch(/<!--\s*citspark:/);
      expect(unescapeSectionText(e)).toBe(t);
    }
    const note = renderSections({ user: "see <!-- citspark:user:end --> here" });
    expect(parseBody(note)?.length).toBe(3);
  });
});

describe("mergeNote", () => {
  const base = fm(ID + "title: T\n", body("one\ntwo\n"));

  it("merges vault user text with a library change to another section", () => {
    const vault = fm(ID + "title: T\n", body("one\ntwo\nthree\n"));
    const library = fm(ID + "title: T\n", body("one\ntwo\n", "ai v2\n"));
    const r = mergeNote({ base, vault, library });
    expect(r).toEqual({
      status: "clean",
      text: fm(ID + "title: T\n", body("one\ntwo\nthree\n", "ai v2\n")),
      changed: true,
    });
  });

  it("merges each section independently, so edits at section edges do not collide", () => {
    const vault = fm(ID + "title: T\n", body("one\ntwo\nlast user line\n"));
    const library = fm(ID + "title: T\n", body("one\ntwo\n", "first ai line\nai\n"));
    expect(mergeNote({ base, vault, library }).status).toBe("clean");
  });

  it("reports a conflict and returns no text when both sides edit the same user line", () => {
    const vault = fm(ID + "title: T\n", body("ONE\ntwo\n"));
    const library = fm(ID + "title: T\n", body("uno\ntwo\n"));
    const r = mergeNote({ base, vault, library });
    expect(r).toEqual({
      status: "conflict",
      conflicts: [
        {
          kind: "content",
          section: "user",
          hunks: [{ baseLine: 1, base: "one\n", vault: "ONE\n", library: "uno\n" }],
        },
      ],
    });
  });

  it("reports same-key metadata changes as a conflict even when bodies merge", () => {
    const vault = fm(ID + "title: V\n", body("one\ntwo\nthree\n"));
    const library = fm(ID + "title: L\n", body("one\ntwo\n"));
    const r = mergeNote({ base, vault, library });
    expect(r.status).toBe("conflict");
    expect(r.status === "conflict" && r.conflicts).toEqual([
      { kind: "metadata", key: ["title"], base: "T", vault: "V", library: "L" },
    ]);
  });

  it("reports a vault edit to the source section as a user-authored version (SYN-02)", () => {
    const edited = base.replace("original\n", "my &lt;!-- citspark: edit\n");
    const r = mergeNote({ base, vault: edited, library: base });
    expect(r).toMatchObject({
      status: "clean",
      text: edited,
      changed: false,
      sourceEdit: { text: "\nmy <!-- citspark: edit\n", libraryText: "\noriginal\n" },
    });
  });

  it("falls back to a whole-body merge when the vault removed markers", () => {
    const vault = fm(ID + "title: T\n", "just my text\n" + body("one\ntwo\n"));
    const stripped = vault.replace("<!-- citspark:generated:begin -->\n", "");
    const r = mergeNote({ base, vault: stripped, library: base });
    expect(r).toEqual({ status: "clean", text: stripped, changed: false });
  });

  it("keeps the vault's CRLF line endings and BOM", () => {
    const crlf = "\uFEFF" + fm(ID + "title: T\n", body("one\ntwo\nthree\n")).replace(/\n/g, "\r\n");
    const library = fm(ID + "title: L\n", body("one\ntwo\n"));
    const r = mergeNote({ base, vault: crlf, library });
    expect(r).toMatchObject({
      status: "clean",
      text: "\uFEFF" + fm(ID + "title: L\n", body("one\ntwo\nthree\n")).replace(/\n/g, "\r\n"),
    });
  });

  it("refuses notes with a newer schema version", () => {
    const newer = base.replace("schema: 1", "schema: 2");
    const r = mergeNote({ base, vault: newer, library: base });
    expect(r).toEqual({
      status: "conflict",
      conflicts: [{ kind: "schema", side: "vault", version: "2" }],
    });
  });

  it("never changes the body of an included user note (managed: false)", () => {
    const meta = "citspark:\n  schema: 1\n  id: 01J9\n  kind: user_note\n  managed: false\n";
    const b = fm(meta + "tags: [a]\n", "my own note\n");
    const v = fm(meta + "tags: [a]\n", "my own note, edited\n");
    const ownedMeta = meta.replace("kind: user_note", "kind: annotation");
    const l = fm(ownedMeta + "tags: [a]\n", "my own note\n");
    expect(mergeNote({ base: b, vault: v, library: l })).toEqual({
      status: "clean",
      text: fm(ownedMeta + "tags: [ a ]\n", "my own note, edited\n"),
      changed: true,
    });
    const libraryBody = fm(meta + "tags: [a]\n", "rewritten by library\n");
    expect(mergeNote({ base: b, vault: b, library: libraryBody })).toEqual({
      status: "conflict",
      conflicts: [{ kind: "readonly_body" }],
    });
  });
});
