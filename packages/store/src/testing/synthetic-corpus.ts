// Synthetic corpus for index tests. Deterministic; no real posts, accounts, or URLs beyond example.com.
import type Database from "better-sqlite3";

const WORDS = [
  "archive",
  "bookmark",
  "citation",
  "evidence",
  "library",
  "passage",
  "research",
  "source",
  "version",
  "offset",
  "generation",
  "keyword",
  "reader",
  "context",
  "summary",
  "thread",
];
const UNICODE = [
  "café crème",
  "日本語のテキスト",
  "한국어 문장",
  "Ελληνικά",
  "кириллица",
  "👩‍👩‍👧‍👦 family",
  "e\u0301clair",
];

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

/** Text of document `i`; contains the unique term `doc{i}` and, for articles, several paragraphs. */
export function documentText(i: number, article: boolean): string {
  const r = rng(i + 1);
  const sentence = () => {
    const n = 6 + Math.floor(r() * 8);
    const words = Array.from({ length: n }, () => WORDS[Math.floor(r() * WORDS.length)]!);
    if (r() < 0.3) words.splice(2, 0, UNICODE[Math.floor(r() * UNICODE.length)]!);
    return words.join(" ") + ".";
  };
  const paragraphs = article ? 4 + (i % 3) : 1;
  const body = Array.from({ length: paragraphs }, () =>
    Array.from({ length: article ? 6 : 2 }, sentence).join(" "),
  );
  body[0] = `doc${i} ${body[0]}`;
  return body.join("\n\n");
}

export interface SeededDoc {
  sourceId: string;
  versionId: number;
  text: string;
}

/** Inserts `count` sources with one version each; every fifth document is a multi-chunk article. */
export function seedCorpus(db: Database.Database, count: number, from = 0): SeededDoc[] {
  const insSource = db.prepare(
    "INSERT INTO source (id, source_type, platform_id, canonical_url) VALUES (?, ?, ?, ?)",
  );
  const insVersion = db.prepare(
    "INSERT INTO source_version (source_id, content_hash, text, completeness) VALUES (?, ?, ?, ?)",
  );
  const docs: SeededDoc[] = [];
  db.transaction(() => {
    for (let i = from; i < from + count; i++) {
      const article = i % 5 === 4;
      const sourceId = `${article ? "article" : "x_post"}:${i}`;
      // 19-digit synthetic platform IDs stay strings (CAP-02).
      const platformId = article ? null : String(1_000_000_000_000_000_000n + BigInt(i));
      insSource.run(
        sourceId,
        article ? "article" : "x_post",
        platformId,
        `https://example.com/${article ? "a" : "p"}/${i}`,
      );
      const text = documentText(i, article);
      const versionId = Number(
        insVersion.run(sourceId, `h${i}`, text, article ? "partial" : "complete").lastInsertRowid,
      );
      docs.push({ sourceId, versionId, text });
    }
  })();
  return docs;
}
