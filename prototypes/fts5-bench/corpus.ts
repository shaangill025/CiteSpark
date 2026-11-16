import { DatabaseSync } from 'node:sqlite';

export interface CorpusSpec {
  posts: number;
  articles: number;
  seed: number;
}

export const DEFAULT_SPEC: CorpusSpec = { posts: 100_000, articles: 15_000, seed: 20261116 };
export const COLLECTIONS = ['bookmarks', 'likes', 'folder:research', 'folder:reading'] as const;
export const PLANTED_TOKEN = 'zqxplantedtoken';
export const PLANTED_DOCS = 37;
export const PLANTED_TRASHED = 5;
const VOCAB_SIZE = 40_000;
const ARTICLE_CHUNK_CHARS = 1_000;
const EPOCH_2020 = Date.UTC(2020, 0, 1);
const SPAN_MS = 6 * 365 * 24 * 3600 * 1000;

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SYLLABLES = ['ka', 'lo', 'mi', 'ten', 'ra', 'su', 'vor', 'el', 'qui', 'dan', 'pe', 'zor', 'ni', 'ba', 'tho', 'gle', 'wy', 'fu', 'cre', 'sha', 'ox', 'ly', 'mon', 'dri'];
const UNICODE_SNIPPETS = ['café', 'naïve façade', 'Zürich', '東京の天気', '데이터 보존', 'données', '🚀 launch', 'Ελληνικά', 'русский текст'];

export interface Vocabulary {
  words: string[];
  sample(r: () => number): string;
}

/** Zipf(s=1.07) over a synthetic vocabulary, close to the rank-frequency curve of English text. */
export function vocabulary(seed: number): Vocabulary {
  const r = rng(seed ^ 0x9e3779b9);
  const seen = new Set<string>();
  const words: string[] = [];
  while (words.length < VOCAB_SIZE) {
    const n = 1 + Math.floor(r() * 4);
    let w = '';
    for (let i = 0; i < n; i++) w += SYLLABLES[Math.floor(r() * SYLLABLES.length)];
    if (w.length >= 3 && !seen.has(w)) {
      seen.add(w);
      words.push(w);
    }
  }
  const cdf = new Float64Array(VOCAB_SIZE);
  let acc = 0;
  for (let i = 0; i < VOCAB_SIZE; i++) cdf[i] = acc += 1 / Math.pow(i + 1, 1.07);
  for (let i = 0; i < VOCAB_SIZE; i++) cdf[i] /= acc;
  return {
    words,
    sample(rr) {
      const x = rr();
      let lo = 0;
      let hi = VOCAB_SIZE - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cdf[mid] < x) lo = mid + 1;
        else hi = mid;
      }
      return words[lo];
    },
  };
}

function sentence(v: Vocabulary, r: () => number, words: number): string {
  const out: string[] = [];
  for (let i = 0; i < words; i++) out.push(v.sample(r));
  if (r() < 0.05) out.splice(Math.floor(r() * out.length), 0, UNICODE_SNIPPETS[Math.floor(r() * UNICODE_SNIPPETS.length)]);
  return out.join(' ');
}

function postLength(r: () => number): number {
  const x = r();
  if (x < 0.7) return 6 + Math.floor(r() * 40);
  if (x < 0.95) return 40 + Math.floor(r() * 60);
  return 150 + Math.floor(r() * 250);
}

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
CREATE TABLE source (
  rowid INTEGER PRIMARY KEY,
  id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL,
  author TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  trashed INTEGER NOT NULL DEFAULT 0
) STRICT;
CREATE INDEX source_published ON source (published_at);
CREATE TABLE membership (
  collection TEXT NOT NULL,
  source_rowid INTEGER NOT NULL REFERENCES source(rowid),
  PRIMARY KEY (collection, source_rowid)
) STRICT, WITHOUT ROWID;
CREATE TABLE chunk (
  rowid INTEGER PRIMARY KEY,
  source_rowid INTEGER NOT NULL REFERENCES source(rowid),
  version_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  start_offset INTEGER NOT NULL,
  end_offset INTEGER NOT NULL,
  text TEXT NOT NULL
) STRICT;
CREATE INDEX chunk_source ON chunk (source_rowid);
`;

export const FTS_UNICODE = `CREATE VIRTUAL TABLE chunk_fts USING fts5(text, content='chunk', content_rowid='rowid', tokenize='unicode61 remove_diacritics 2');`;
export const FTS_TRIGRAM = `CREATE VIRTUAL TABLE chunk_tri USING fts5(text, content='chunk', content_rowid='rowid', tokenize='trigram');`;

export interface BuildStats {
  sources: number;
  chunks: number;
  postChunks: number;
  articleChunks: number;
  textBytes: number;
  loadMs: number;
  ftsBuildMs: number;
  trigramBuildMs: number | null;
}

export function build(path: string, spec: CorpusSpec, withTrigram: boolean): BuildStats {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const v = vocabulary(spec.seed);
  const r = rng(spec.seed);
  const insSource = db.prepare('INSERT INTO source (rowid, id, kind, author, published_at, trashed) VALUES (?, ?, ?, ?, ?, ?)');
  const insMember = db.prepare('INSERT INTO membership (collection, source_rowid) VALUES (?, ?)');
  const insChunk = db.prepare('INSERT INTO chunk (source_rowid, version_id, doc_type, start_offset, end_offset, text) VALUES (?, ?, ?, ?, ?, ?)');
  let textBytes = 0;
  let postChunks = 0;
  let articleChunks = 0;

  const t0 = performance.now();
  db.exec('BEGIN');
  for (let i = 1; i <= spec.posts; i++) {
    const planted = i % Math.floor(spec.posts / PLANTED_DOCS) === 0 && i / Math.floor(spec.posts / PLANTED_DOCS) <= PLANTED_DOCS;
    const plantedIndex = planted ? i / Math.floor(spec.posts / PLANTED_DOCS) : 0;
    const trashed = planted ? plantedIndex <= PLANTED_TRASHED : r() < 0.01;
    insSource.run(i, `x:post:18${String(i).padStart(17, '0')}`, 'post', `x:user:${Math.floor(r() * 5000)}`, EPOCH_2020 + Math.floor(r() * SPAN_MS), trashed ? 1 : 0);
    insMember.run(r() < 0.6 ? 'bookmarks' : 'likes', i);
    if (r() < 0.15) insMember.run(r() < 0.5 ? 'folder:research' : 'folder:reading', i);
    let text = sentence(v, r, postLength(r));
    if (planted) text += ` ${PLANTED_TOKEN}`;
    textBytes += Buffer.byteLength(text);
    insChunk.run(i, `v:${i}:1`, 'post', 0, text.length, text);
    postChunks++;
  }
  for (let a = 1; a <= spec.articles; a++) {
    const rowid = spec.posts + a;
    insSource.run(rowid, `web:article:${a}`, 'article', `web:site:${Math.floor(r() * 800)}`, EPOCH_2020 + Math.floor(r() * SPAN_MS), r() < 0.01 ? 1 : 0);
    insMember.run('bookmarks', rowid);
    const paragraphs = 4 + Math.floor(r() * 16);
    let body = '';
    for (let p = 0; p < paragraphs; p++) body += sentence(v, r, 40 + Math.floor(r() * 80)) + '\n\n';
    textBytes += Buffer.byteLength(body);
    for (let off = 0; off < body.length; off += ARTICLE_CHUNK_CHARS) {
      const end = Math.min(body.length, off + ARTICLE_CHUNK_CHARS);
      insChunk.run(rowid, `v:${rowid}:1`, 'article', off, end, body.slice(off, end));
      articleChunks++;
    }
  }
  db.exec('COMMIT');
  const loadMs = performance.now() - t0;

  const t1 = performance.now();
  db.exec(FTS_UNICODE);
  db.exec("INSERT INTO chunk_fts (chunk_fts) VALUES ('rebuild'); INSERT INTO chunk_fts (chunk_fts) VALUES ('optimize');");
  const ftsBuildMs = performance.now() - t1;

  let trigramBuildMs: number | null = null;
  if (withTrigram) {
    const t2 = performance.now();
    db.exec(FTS_TRIGRAM);
    db.exec("INSERT INTO chunk_tri (chunk_tri) VALUES ('rebuild'); INSERT INTO chunk_tri (chunk_tri) VALUES ('optimize');");
    trigramBuildMs = performance.now() - t2;
  }
  db.exec('ANALYZE; PRAGMA wal_checkpoint(TRUNCATE);');
  db.close();
  return {
    sources: spec.posts + spec.articles,
    chunks: postChunks + articleChunks,
    postChunks,
    articleChunks,
    textBytes,
    loadMs,
    ftsBuildMs,
    trigramBuildMs,
  };
}
