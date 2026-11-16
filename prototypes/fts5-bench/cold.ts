import { openReadOnly, searcher, type Query } from './search.ts';

const [path, queryJson, hasTrigram] = process.argv.slice(2);
const q = JSON.parse(queryJson) as Query;
const t0 = performance.now();
const db = openReadOnly(path);
const s = searcher(db, hasTrigram === '1');
const t1 = performance.now();
const rows = s.run(q);
const t2 = performance.now();
process.stdout.write(JSON.stringify({ openMs: t1 - t0, firstQueryMs: t2 - t1, rows: rows.length }));
