import Database from "better-sqlite3";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GenerationStateError,
  GenerationVerificationError,
  IndexStore,
  TrigramUnavailableError,
  migrate,
  type SearchHit,
} from "./index.ts";
import { seedCorpus, type SeededDoc } from "./testing/synthetic-corpus.ts";

let db: Database.Database;
let index: IndexStore;
let docs: SeededDoc[];

const SMALL = { maxChars: 120, overlapChars: 20 };
const QUERIES = ["doc3", "citation evidence", "library", "archive passage", "doc14"];
const snapshot = () => QUERIES.map((q) => index.search(q, { limit: 50 }));
const textOf = (versionId: number) =>
  db.prepare("SELECT text FROM source_version WHERE id = ?").pluck().get(versionId) as string;

function expectExactHits(hits: SearchHit[]): void {
  for (const h of hits) expect(textOf(h.versionId).slice(h.start, h.end)).toBe(h.text);
}

beforeEach(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrate(db);
  docs = seedCorpus(db, 40);
  index = new IndexStore(db);
});

describe("IndexStore generations", () => {
  it("returns nothing before the first switch, then exact, citable hits", () => {
    expect(index.active()).toBe(0);
    expect(index.search("doc3")).toEqual([]);
    const g = index.build();
    expect(index.generation(g).state).toBe("ready");
    expect(index.search("doc3")).toEqual([]); // a candidate is never visible before the switch
    index.activate(g);
    const [hit] = index.search("doc3");
    expect(hit).toMatchObject({
      sourceId: "x_post:3",
      versionId: docs[3]!.versionId,
      documentType: "x_post",
      canonicalUrl: "https://example.com/p/3",
      completeness: "complete",
      generation: g,
    });
    expect(docs[3]!.text.slice(hit!.start, hit!.end)).toBe(hit!.text);
    expect(index.generation(g)).toMatchObject({
      state: "active",
      tokenizer: "unicode61 remove_diacritics 2",
    });
  });

  it("maps every chunk of a multi-chunk article back to its exact text", () => {
    index.activate(index.build({ chunker: SMALL }));
    const article = docs[4]!;
    const chunks = db
      .prepare("SELECT char_start s, char_end e, text FROM chunk WHERE version_id = ? ORDER BY s")
      .all(article.versionId) as { s: number; e: number; text: string }[];
    expect(chunks.length).toBeGreaterThan(3);
    for (const c of chunks) expect(article.text.slice(c.s, c.e)).toBe(c.text);
    expectExactHits(index.search("library", { limit: 200 }));
  });

  it("keeps serving the active generation while a candidate builds, then switches atomically", () => {
    const g1 = index.build();
    index.activate(g1);
    const before = snapshot();
    const g2 = index.build({ chunker: SMALL, batchSize: 7 });
    expect(snapshot()).toEqual(before);
    index.activate(g2);
    expect(index.active()).toBe(g2);
    expect(index.previous()).toBe(g1);
    expect(index.generation(g1).state).toBe("retired");
    const after = snapshot();
    expect(after).not.toEqual(before);
    for (const hits of after) for (const h of hits) expect(h.generation).toBe(g2);
  });

  it("rollback restores the previous generation's exact results", () => {
    const g1 = index.build();
    index.activate(g1);
    const before = snapshot();
    const g2 = index.build({ chunker: SMALL });
    index.activate(g2);
    expect(index.rollback()).toBe(g1);
    expect(index.active()).toBe(g1);
    expect(index.previous()).toBe(g2);
    expect(snapshot()).toEqual(before);
  });

  it("refuses to drop the active generation and ends rollback when the previous one is dropped", () => {
    const g1 = index.build();
    index.activate(g1);
    const g2 = index.build();
    index.activate(g2);
    expect(() => index.drop(g2)).toThrow(GenerationStateError);
    index.drop(g1);
    expect(index.previous()).toBeNull();
    expect(index.generation(g1)).toMatchObject({ state: "dropped", chunkCount: 0 });
    expect(
      db.prepare("SELECT COUNT(*) FROM chunk WHERE index_generation = ?").pluck().get(g1),
    ).toBe(0);
    expect(() => index.rollback()).toThrow(GenerationStateError);
    expect(() => index.activate(g1)).toThrow(GenerationStateError);
  });

  it("verification blocks a switch to a generation whose offsets no longer reproduce its text", () => {
    const g1 = index.build();
    index.activate(g1);
    const g2 = index.build();
    db.prepare(
      "UPDATE chunk SET char_start = char_start + 1 WHERE id = (SELECT MIN(id) FROM chunk WHERE index_generation = ?)",
    ).run(g2);
    expect(() => index.activate(g2)).toThrow(GenerationVerificationError);
    expect(index.active()).toBe(g1);
  });

  it("verification detects an FTS index that does not match its chunks", () => {
    const g = index.build();
    db.prepare(`INSERT INTO chunk_fts_g${g} (rowid, text) VALUES (999999, 'phantom')`).run();
    expect(() => index.verify(g)).toThrow(GenerationVerificationError);
  });

  it("indexes new versions incrementally and on switch", () => {
    index.activate(index.build());
    seedCorpus(db, 5, 100);
    expect(index.search("doc102")).toEqual([]);
    expect(index.indexPending({ batchSize: 2 })).toBe(5);
    expect(index.search("doc102")).toHaveLength(1);
    expect(index.indexPending()).toBe(0);
    index.verify(index.active());

    const g2 = index.build();
    seedCorpus(db, 3, 200); // committed after the candidate was built
    index.activate(g2);
    expectExactHits(index.search("doc201"));
    expect(index.search("doc201")).toHaveLength(1);
  });

  it("excludes trashed sources at query time without touching the index", () => {
    index.activate(index.build());
    db.prepare("UPDATE source SET trashed_at = '2026-01-01T00:00:00Z' WHERE id = 'x_post:3'").run();
    expect(index.search("doc3")).toEqual([]);
    index.verify(index.active());
  });

  it("treats query text as literal terms", () => {
    index.activate(index.build());
    for (const q of ['doc3 AND "(', "NEAR(", "*", "-", "doc3 OR"])
      expect(() => index.search(q)).not.toThrow();
    expect(index.search("   ")).toEqual([]);
  });

  it("preserves Unicode and folds diacritics for keyword search", () => {
    index.activate(index.build());
    const hits = index.search("cafe", { limit: 100 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.text.includes("café"))).toBe(true);
    expectExactHits(hits);
  });

  it("serves substring search only from a generation built with trigram (LAN-01)", () => {
    const plain = index.build();
    index.activate(plain);
    expect(() => index.search("本語の", { mode: "substring" })).toThrow(TrigramUnavailableError);
    // unicode61 does not segment CJK: a substring of a CJK run is not a keyword match.
    expect(index.search("本語の")).toEqual([]);

    const tri = index.build({ trigram: true });
    expect(index.generation(tri).trigram).toBe(true);
    index.activate(tri);
    const hits = index.search("本語の", { mode: "substring", limit: 100 });
    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.text.includes("本語の") && h.score === null)).toBe(true);
    expectExactHits(hits);
    expect(index.search("本語", { mode: "substring" })).toEqual([]); // below the trigram minimum

    // The mode follows the active generation, so rolling back disables substring search again.
    index.rollback();
    expect(() => index.search("本語の", { mode: "substring" })).toThrow(TrigramUnavailableError);
  });

  it("recover() removes a build interrupted mid-way and leaves the active generation serving", () => {
    const g1 = index.build();
    index.activate(g1);
    const before = snapshot();
    const boom = new Error("crash");
    expect(() =>
      index.build({
        batchSize: 5,
        onFaultPoint: () => {
          throw boom;
        },
      }),
    ).toThrow(boom);
    const [stale] = index.generations().filter((g) => g.state === "building");
    expect(stale).toBeDefined();
    expect(index.recover()).toEqual([stale!.generation]);
    expect(index.generation(stale!.generation).state).toBe("failed");
    expect(
      db
        .prepare("SELECT COUNT(*) FROM chunk WHERE index_generation = ?")
        .pluck()
        .get(stale!.generation),
    ).toBe(0);
    expect(snapshot()).toEqual(before);
    // Generation numbers are never reused, so table names never collide with a failed build.
    expect(index.build()).toBe(stale!.generation + 1);
  });
});
