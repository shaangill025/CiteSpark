import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { COLLECTIONS, rng, vocabulary } from './corpus.ts';

export type QueryKind = 'rare' | 'mid' | 'common' | 'and2' | 'phrase' | 'prefix' | 'exact-id' | 'substring';

export interface Query {
  kind: QueryKind;
  match: string;
  filtered: boolean;
  collection: string;
  from: number;
  to: number;
}

const BASE = `SELECT c.rowid, s.id, c.doc_type, c.version_id, c.start_offset, c.end_offset,
  snippet(chunk_fts, 0, '[', ']', '…', 12) AS excerpt, bm25(chunk_fts) AS score
FROM chunk_fts JOIN chunk c ON c.rowid = chunk_fts.rowid JOIN source s ON s.rowid = c.source_rowid
WHERE chunk_fts MATCH ? AND s.trashed = 0`;
const FILTER = ` AND s.published_at BETWEEN ? AND ? AND EXISTS (SELECT 1 FROM membership m WHERE m.source_rowid = s.rowid AND m.collection = ?)`;
const TAIL = ' ORDER BY score LIMIT 20';
const TRIGRAM = `SELECT c.rowid, s.id, c.start_offset FROM chunk_tri JOIN chunk c ON c.rowid = chunk_tri.rowid JOIN source s ON s.rowid = c.source_rowid
WHERE chunk_tri MATCH ? AND s.trashed = 0 LIMIT 20`;
const EXACT = `SELECT s.id, c.rowid, c.text FROM source s JOIN chunk c ON c.source_rowid = s.rowid WHERE s.id = ? AND s.trashed = 0`;

export interface Searcher {
  run(q: Query): unknown[];
}

export function searcher(db: DatabaseSync, hasTrigram: boolean): Searcher {
  const plain = db.prepare(BASE + TAIL);
  const filtered = db.prepare(BASE + FILTER + TAIL);
  const exact = db.prepare(EXACT);
  const tri: StatementSync | null = hasTrigram ? db.prepare(TRIGRAM) : null;
  return {
    run(q) {
      if (q.kind === 'exact-id') return exact.all(q.match);
      if (q.kind === 'substring') return tri!.all(q.match);
      return q.filtered ? filtered.all(q.match, q.from, q.to, q.collection) : plain.all(q.match);
    },
  };
}

export function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.exec('PRAGMA mmap_size = 268435456; PRAGMA cache_size = -65536;');
  return db;
}

const quote = (w: string) => `"${w}"`;

export function querySet(db: DatabaseSync, seed: number, perKind: number, hasTrigram: boolean): Query[] {
  const v = vocabulary(seed);
  const r = rng(seed ^ 0x51ed270b);
  const pick = (lo: number, hi: number) => v.words[lo + Math.floor(r() * (hi - lo))];
  const maxRow = (db.prepare('SELECT max(rowid) m FROM chunk').get() as { m: number }).m;
  const maxSource = (db.prepare('SELECT max(rowid) m FROM source WHERE kind = ?').get('post') as { m: number }).m;
  const chunkText = db.prepare('SELECT text FROM chunk WHERE rowid = ?');
  const adjacentPair = (): string => {
    for (;;) {
      const row = chunkText.get(1 + Math.floor(r() * maxRow)) as { text: string } | undefined;
      const words = row?.text.split(/\s+/).filter((w) => /^[a-z]+$/.test(w)) ?? [];
      if (words.length >= 2) {
        const i = Math.floor(r() * (words.length - 1));
        return `"${words[i]} ${words[i + 1]}"`;
      }
    }
  };
  const year = 365 * 24 * 3600 * 1000;
  const make = (kind: QueryKind, match: string): Query => {
    const from = Date.UTC(2020, 0, 1) + Math.floor(r() * 4) * year;
    return { kind, match, filtered: r() < 0.5, collection: COLLECTIONS[Math.floor(r() * COLLECTIONS.length)], from, to: from + 2 * year };
  };
  const qs: Query[] = [];
  for (let i = 0; i < perKind; i++) {
    qs.push(make('rare', quote(pick(20_000, 40_000))));
    qs.push(make('mid', quote(pick(500, 3_000))));
    qs.push(make('common', quote(pick(0, 50))));
    qs.push(make('and2', `${quote(pick(200, 3_000))} AND ${quote(pick(200, 3_000))}`));
    qs.push(make('phrase', adjacentPair()));
    qs.push(make('prefix', `${quote(pick(500, 3_000).slice(0, 4))}*`));
    qs.push(make('exact-id', `x:post:18${String(1 + Math.floor(r() * maxSource)).padStart(17, '0')}`));
    if (hasTrigram) {
      const w = pick(300, 5_000);
      qs.push(make('substring', quote(w.length > 5 ? w.slice(1, 5) : w)));
    }
  }
  return qs;
}
