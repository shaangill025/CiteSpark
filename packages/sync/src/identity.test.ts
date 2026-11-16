import Database from "better-sqlite3";
import { migrate } from "@citspark/store";
import { describe, expect, it } from "vitest";
import { identify, type KnownBinding } from "./identity.ts";
import {
  getBinding,
  listBindings,
  listConflicts,
  mergeConflictRecord,
  recordConflict,
  saveBinding,
  setConflictStatus,
  type Binding,
} from "./persistence.ts";
import { contentHash } from "./text.ts";

const bound = (noteId: string, path: string, extra: Partial<KnownBinding> = {}): KnownBinding => ({
  noteId,
  path,
  state: "bound",
  baseHash: `h-${noteId}`,
  libraryChanged: false,
  ...extra,
});

describe("identify (SYN-01, ADR 0007 step 2)", () => {
  it("identifies by ID first: same path, move, duplicate, unknown ID", () => {
    const d = identify(
      [
        { path: "a.md", id: "A", hash: "x" },
        { path: "new/b.md", id: "B", hash: "h-C" },
        { path: "c1.md", id: "C", hash: "y" },
        { path: "c2.md", id: "C", hash: "y" },
        { path: "z.md", id: "Z", hash: "z" },
      ],
      [bound("A", "a.md"), bound("B", "b.md"), bound("C", "c.md")],
    );
    expect(d).toEqual([
      { type: "present", noteId: "A", path: "a.md" },
      { type: "duplicate", noteId: "C", paths: ["c1.md", "c2.md"] },
      { type: "moved", noteId: "B", from: "b.md", to: "new/b.md" },
      { type: "unbound", path: "z.md", id: "Z", reason: "unknown_id" },
    ]);
  });

  it("falls back to hash only for ID-less files, only for missing bindings, only when unique", () => {
    const d = identify(
      [
        { path: "renamed.md", id: null, hash: "h-A" },
        { path: "copy1.md", id: null, hash: "h-B" },
        { path: "copy2.md", id: null, hash: "h-B" },
        { path: "present-copy.md", id: null, hash: "h-P" },
        { path: "p.md", id: "P", hash: "h-P" },
        { path: "fresh.md", id: null, hash: "q" },
      ],
      [bound("A", "a.md"), bound("B", "b.md"), bound("P", "p.md")],
    );
    expect(d).toEqual([
      { type: "ambiguous_hash", noteId: "B", path: "b.md", paths: ["copy1.md", "copy2.md"] },
      { type: "unbound", path: "copy1.md", id: null, reason: "ambiguous_hash" },
      { type: "unbound", path: "copy2.md", id: null, reason: "ambiguous_hash" },
      { type: "unbound", path: "fresh.md", id: null, reason: "no_id" },
      { type: "present", noteId: "P", path: "p.md" },
      { type: "unbound", path: "present-copy.md", id: null, reason: "no_id" },
      { type: "matched_by_hash", noteId: "A", from: "a.md", to: "renamed.md" },
    ]);
  });

  it("does not hash-match when two bindings share the base hash", () => {
    const d = identify(
      [{ path: "x.md", id: null, hash: "same" }],
      [bound("A", "a.md", { baseHash: "same" }), bound("B", "b.md", { baseHash: "same" })],
    );
    expect(d.find((x) => x.type === "unbound")).toMatchObject({ reason: "ambiguous_hash" });
    expect(d.filter((x) => x.type === "deleted")).toHaveLength(0);
    expect(d.filter((x) => x.type === "ambiguous_hash")).toHaveLength(2);
  });

  it("separates deletion, delete-versus-edit, and unlinked restore candidates (SYN-03, SYN-04)", () => {
    const d = identify(
      [{ path: "back.md", id: "U", hash: "u" }],
      [
        bound("D", "d.md"),
        bound("E", "e.md", { libraryChanged: true }),
        bound("U", "u.md", { state: "unlinked" }),
        bound("G", "g.md", { state: "unlinked" }),
      ],
    );
    expect(d).toEqual([
      { type: "restore_candidate", noteId: "U", path: "back.md" },
      { type: "deleted", noteId: "D", path: "d.md" },
      { type: "delete_vs_edit", noteId: "E", path: "e.md" },
    ]);
  });
});

describe("persistence", () => {
  const setup = (): Database.Database => {
    const db = new Database(":memory:");
    migrate(db);
    return db;
  };
  const key = { libraryId: "lib", vaultId: "vault", noteId: "01J9" };

  it("stores the base compressed and verifies it by hash", () => {
    const db = setup();
    const base = "---\ncitspark:\n  id: 01J9\n---\n" + "text ".repeat(1000);
    const b: Binding = {
      ...key,
      sourceId: null,
      path: "n.md",
      state: "bound",
      suppression: "none",
      base,
      baseHash: contentHash(base),
      lastWrittenHash: contentHash(base),
      lastTxnId: "t1",
    };
    saveBinding(db, b);
    expect(getBinding(db, key)).toEqual(b);
    const stored = db.prepare("SELECT length(base_content) n FROM sync_binding").get() as {
      n: number;
    };
    expect(stored.n).toBeLessThan(base.length / 10);

    saveBinding(db, { ...b, path: "moved.md", state: "conflict" });
    expect(listBindings(db, "lib", "vault").map((x) => [x.path, x.state])).toEqual([
      ["moved.md", "conflict"],
    ]);
    expect(() => saveBinding(db, { ...b, baseHash: "sha256:wrong" })).toThrow(/does not match/);

    db.prepare("UPDATE sync_binding SET last_common_hash = 'sha256:tampered'").run();
    expect(() => getBinding(db, key)).toThrow(/does not match/);
  });

  it("keeps all three variants of a conflict verbatim for review (SYN-03)", () => {
    const db = setup();
    const versions = { base: "b\n", vault: "v \u00e9\r\n", library: "l\n" };
    const conflicts = [{ kind: "metadata" as const, key: ["n"], base: 1n, vault: 2n, library: 3n }];
    const id = recordConflict(db, mergeConflictRecord(key, "n.md", versions, conflicts));
    const [rec] = listConflicts(db, "lib", "vault");
    expect(rec).toMatchObject({ id, kind: "merge", path: "n.md", status: "open", ...versions });
    expect(rec?.details).toEqual({
      conflicts: [{ kind: "metadata", key: ["n"], base: "1", vault: "2", library: "3" }],
    });

    setConflictStatus(db, id, "resolved");
    expect(listConflicts(db, "lib", "vault")).toEqual([]);
    expect(listConflicts(db, "lib", "vault", "resolved")).toHaveLength(1);
    expect(() => setConflictStatus(db, 999, "resolved")).toThrow();
  });
});
