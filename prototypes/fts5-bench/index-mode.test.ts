import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const runBench = (db: string, out: string, trigram: boolean) => {
  const r = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types', '--no-warnings', join(import.meta.dirname, 'run.ts'),
      '--db', db, '--out', out, '--posts', '2000', '--articles', '20', '--runs', '1', '--per-kind', '3', '--cold', '1',
      ...(trigram ? ['--trigram'] : []),
    ],
    { encoding: 'utf8' },
  );
  assert.equal(r.status, 0, r.stderr);
  return (JSON.parse(readFileSync(out, 'utf8')) as { corpus: { trigramBuildMs: number | null } }).corpus;
};

test('an existing database is rebuilt when the requested index mode differs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fts5-mode-'));
  try {
    const db = join(dir, 'library.db');
    assert.equal(runBench(db, join(dir, 'a.json'), false).trigramBuildMs, null);
    assert.notEqual(runBench(db, join(dir, 'b.json'), true).trigramBuildMs, null);
    assert.equal(runBench(db, join(dir, 'c.json'), false).trigramBuildMs, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
