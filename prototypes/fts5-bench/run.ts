import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { cpus, loadavg, release, totalmem } from 'node:os';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';
import { DEFAULT_SPEC, PLANTED_DOCS, PLANTED_TOKEN, PLANTED_TRASHED, build, type BuildStats } from './corpus.ts';
import { openReadOnly, querySet, searcher, type Query, type QueryKind } from './search.ts';

const { values: args } = parseArgs({
  options: {
    db: { type: 'string', default: '/tmp/citspark-f0/fts5/library.db' },
    rebuild: { type: 'boolean', default: false },
    posts: { type: 'string', default: String(DEFAULT_SPEC.posts) },
    articles: { type: 'string', default: String(DEFAULT_SPEC.articles) },
    trigram: { type: 'boolean', default: false },
    runs: { type: 'string', default: '5' },
    'per-kind': { type: 'string', default: '40' },
    cold: { type: 'string', default: '21' },
    out: { type: 'string' },
  },
});

const spec = { ...DEFAULT_SPEC, posts: Number(args.posts), articles: Number(args.articles) };
const statsPath = `${args.db}.build.json`;
const builtWithTrigram = (): boolean | null =>
  existsSync(args.db) && existsSync(statsPath)
    ? (JSON.parse(readFileSync(statsPath, 'utf8')) as BuildStats).trigramBuildMs !== null
    : null;
// An existing database is reused only if it was built in the requested index mode.
if (args.rebuild || builtWithTrigram() !== args.trigram) {
  mkdirSync(dirname(args.db), { recursive: true });
  for (const f of [args.db, `${args.db}-wal`, `${args.db}-shm`, statsPath]) rmSync(f, { force: true });
  console.error(`building corpus: ${spec.posts} posts, ${spec.articles} articles`);
  writeFileSync(statsPath, JSON.stringify(build(args.db, spec, args.trigram)));
}
const buildStats = JSON.parse(readFileSync(statsPath, 'utf8')) as BuildStats;
const hasTrigram = buildStats.trigramBuildMs !== null;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};
const summary = (xs: number[]) => ({ n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95), p99: pct(xs, 99), max: Math.max(...xs) });
const round = (o: unknown): unknown =>
  JSON.parse(JSON.stringify(o, (_, v) => (typeof v === 'number' && !Number.isInteger(v) ? Math.round(v * 100) / 100 : v)));

const db = openReadOnly(args.db);
const trigramTables = (db.prepare("SELECT count(*) n FROM sqlite_master WHERE name = 'chunk_tri'").get() as { n: number }).n;
if (hasTrigram !== args.trigram || (trigramTables > 0) !== args.trigram) {
  console.error(`index mode mismatch: requested trigram=${args.trigram}, stats=${hasTrigram}, tables=${trigramTables}`);
  process.exit(1);
}
const sizes = Object.fromEntries(
  (db.prepare(
    `SELECT CASE WHEN name LIKE 'chunk_fts%' THEN 'fts_unicode61' WHEN name LIKE 'chunk_tri%' THEN 'fts_trigram'
      WHEN name LIKE 'chunk%' THEN 'chunk' ELSE 'source_membership_other' END AS part, sum(pgsize) AS bytes FROM dbstat GROUP BY part`,
  ).all() as { part: string; bytes: number }[]).map((r) => [r.part, r.bytes]),
);

const plantedVisible = (db.prepare(
  'SELECT count(*) n FROM chunk_fts JOIN chunk c ON c.rowid = chunk_fts.rowid JOIN source s ON s.rowid = c.source_rowid WHERE chunk_fts MATCH ? AND s.trashed = 0',
).get(`"${PLANTED_TOKEN}"`) as { n: number }).n;
const s = searcher(db, hasTrigram);
const plantedTop = s.run({ kind: 'rare', match: `"${PLANTED_TOKEN}"`, filtered: false, collection: '', from: 0, to: 0 }) as { id: string }[];
const trashedIds = new Set((db.prepare('SELECT id FROM source WHERE trashed = 1').all() as { id: string }[]).map((r) => r.id));
const correctness = {
  plantedVisible,
  plantedExpected: PLANTED_DOCS - PLANTED_TRASHED,
  plantedTopRows: plantedTop.length,
  trashedInTop: plantedTop.filter((r) => trashedIds.has(r.id)).length,
};
if (correctness.plantedVisible !== correctness.plantedExpected || correctness.plantedTopRows !== 20 || correctness.trashedInTop !== 0) {
  console.error('correctness check failed', correctness);
  process.exit(1);
}

const queries = querySet(db, spec.seed, Number(args['per-kind']), hasTrigram);
const loadStart = loadavg();

const coldQueries = queries.filter((q) => q.kind !== 'exact-id' && q.kind !== 'substring').slice(0, Number(args.cold));
const cold = coldQueries.map((q) => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', join(import.meta.dirname, 'cold.ts'), args.db, JSON.stringify(q), hasTrigram ? '1' : '0'], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout) as { openMs: number; firstQueryMs: number; rows: number };
});

const byKind = new Map<QueryKind | 'all', number[]>();
const perRun: { p50: number; p95: number }[] = [];
let errors = 0;
let zeroResult = 0;
const zeroByKind: Record<string, number> = {};
let rowsReturned = 0;
let peakRss = 0;
const timeOne = (q: Query) => {
  const t = performance.now();
  try {
    const rows = s.run(q);
    rowsReturned += rows.length;
    if (rows.length === 0) {
      zeroResult++;
      zeroByKind[q.kind] = (zeroByKind[q.kind] ?? 0) + 1;
    }
  } catch {
    errors++;
  }
  return performance.now() - t;
};
for (const q of queries) timeOne(q);
errors = zeroResult = rowsReturned = 0;
for (const k of Object.keys(zeroByKind)) delete zeroByKind[k];
const ranked = (q: Query) => q.kind !== 'exact-id' && q.kind !== 'substring';
const split = { filtered: [] as number[], unfiltered: [] as number[] };
const latencyByQuery = new Map<Query, number[]>();
for (let run = 0; run < Number(args.runs); run++) {
  const all: number[] = [];
  for (const q of queries) {
    const ms = timeOne(q);
    all.push(ms);
    if (!byKind.has(q.kind)) byKind.set(q.kind, []);
    byKind.get(q.kind)!.push(ms);
    if (ranked(q)) {
      split[q.filtered ? 'filtered' : 'unfiltered'].push(ms);
      if (!latencyByQuery.has(q)) latencyByQuery.set(q, []);
      latencyByQuery.get(q)!.push(ms);
    }
  }
  perRun.push({ p50: pct(all, 50), p95: pct(all, 95) });
  byKind.set('all', [...(byKind.get('all') ?? []), ...all]);
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}

// Ranked FTS latency vs. number of matching chunks (unfiltered queries, median of the timed runs).
const matchCount = db.prepare('SELECT count(*) n FROM chunk_fts WHERE chunk_fts MATCH ?');
const points = [...latencyByQuery]
  .filter(([q]) => !q.filtered)
  .map(([q, xs]) => ({ kind: q.kind, matches: (matchCount.get(q.match) as { n: number }).n, ms: pct(xs, 50) }));
const pearson = (xs: number[], ys: number[]) => {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let c = 0, vx = 0, vy = 0;
  for (let i = 0; i < xs.length; i++) {
    c += (xs[i] - mx) * (ys[i] - my);
    vx += (xs[i] - mx) ** 2;
    vy += (ys[i] - my) ** 2;
  }
  return c / Math.sqrt(vx * vy);
};
const limiter = {
  n: points.length,
  pearsonMatchesVsMedianMs: pearson(points.map((p) => p.matches), points.map((p) => p.ms)),
  topByMatches: [...points].sort((a, b) => b.matches - a.matches).slice(0, 5),
};

const report = round({
  date: new Date().toISOString(),
  environment: {
    cpu: cpus()[0].model,
    logicalCores: cpus().length,
    ramBytes: totalmem(),
    os: `${process.platform} ${release()}`,
    node: process.version,
    sqlite: (db.prepare('SELECT sqlite_version() v').get() as { v: string }).v,
    binding: 'node:sqlite (DatabaseSync)',
    pragmas: 'WAL, mmap_size=256MiB, cache_size=64MiB, read-only connection',
    loadAvgStart: loadStart,
    loadAvgEnd: loadavg(),
  },
  corpus: { spec, ...buildStats, dbFileBytes: statSync(args.db).size, sizes },
  correctness,
  cold: { note: 'fresh process per sample; OS page cache not purged (no sudo)', openMs: summary(cold.map((c) => c.openMs)), firstQueryMs: summary(cold.map((c) => c.firstQueryMs)) },
  warm: {
    queries: queries.length,
    runs: Number(args.runs),
    errors,
    zeroResult,
    zeroByKind: { ...zeroByKind },
    rowsReturned,
    peakRssBytes: peakRss,
    perRun,
    byKind: Object.fromEntries([...byKind].map(([k, xs]) => [k, summary(xs)])),
    rankedUnfiltered: summary(split.unfiltered),
    rankedFiltered: summary(split.filtered),
  },
  limiter,
});
db.close();
const out = args.out ?? join(import.meta.dirname, 'results', `fts5-${spec.posts}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
