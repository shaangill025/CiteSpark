import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  AccountMismatchError,
  CursorMismatchError,
  LeaseLostError,
  acquireLease,
  commitPage,
  createJob,
  openStore,
  readJob,
  type CrashPoint,
} from './store.ts';
import { ACCOUNT, COLLECTION, PAGE_COUNT, allPages, expectedDistinctPosts, expectedDistinctVersions } from './feed.ts';

const WORKER = join(import.meta.dirname, 'capture-worker.ts');
const T0 = 1_800_000_000_000;

function runWorker(db: string, owner: string, now: number, crashPage?: number, crashPoint?: CrashPoint) {
  const args = ['--experimental-strip-types', '--no-warnings', WORKER, db, owner, String(now)];
  if (crashPage !== undefined) args.push(String(crashPage), crashPoint!);
  return spawnSync(process.execPath, args, { encoding: 'utf8' });
}

function withDb(fn: (path: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'citspark-t01-'));
  try {
    fn(join(dir, 'library.db'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Snapshot {
  sources: number;
  versions: number;
  memberships: number;
  observations: number;
  pagesCommitted: number;
  committedPageRows: number;
  cursor: string | null;
  orphanObservations: number;
  sourceIds: Set<string>;
}

function snapshot(path: string): Snapshot {
  const db = new DatabaseSync(path, { readOnly: true });
  const one = (sql: string) => Object.values(db.prepare(sql).get() as object)[0] as number;
  const job = db.prepare('SELECT cursor, pages_committed FROM job').get() as { cursor: string | null; pages_committed: number };
  const s: Snapshot = {
    sources: one('SELECT count(*) FROM source'),
    versions: one('SELECT count(*) FROM source_version'),
    memberships: one('SELECT count(*) FROM membership'),
    observations: one('SELECT count(*) FROM observation'),
    pagesCommitted: job.pages_committed,
    committedPageRows: one('SELECT count(*) FROM committed_page'),
    cursor: job.cursor,
    orphanObservations: one(
      'SELECT count(*) FROM observation o WHERE NOT EXISTS (SELECT 1 FROM committed_page c WHERE c.job_id = o.job_id AND c.page_key = o.page_key)',
    ),
    sourceIds: new Set((db.prepare('SELECT platform_id FROM source').all() as { platform_id: string }[]).map((r) => r.platform_id)),
  };
  db.close();
  return s;
}

const idsOfFirstPages = (n: number) => new Set(allPages().slice(0, n).flatMap((p) => p.records.map((r) => r.platformId)));

function assertComplete(path: string) {
  const s = snapshot(path);
  assert.equal(s.sources, expectedDistinctPosts(), 'one canonical source per platform id');
  assert.equal(s.versions, expectedDistinctVersions(), 'one version per distinct observed text');
  assert.equal(s.memberships, expectedDistinctPosts(), 'one membership per source in the collection');
  assert.equal(s.pagesCommitted, PAGE_COUNT);
  assert.equal(s.committedPageRows, PAGE_COUNT);
  assert.equal(s.cursor, null, 'job reached its recognized end');
  assert.equal(s.orphanObservations, 0);
}

const crashPoints: CrashPoint[] = ['mid-page', 'before-commit', 'after-commit'];
for (const point of crashPoints) {
  for (const crashPage of [0, 5, PAGE_COUNT - 1]) {
    test(`T01 SIGKILL ${point} on page ${crashPage} recovers committed records without duplicates`, () => {
      withDb((path) => {
        const crashed = runWorker(path, 'owner-a', T0, crashPage, point);
        assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);

        const committed = point === 'after-commit' ? crashPage + 1 : crashPage;
        const s = snapshot(path);
        assert.equal(s.pagesCommitted, committed, 'cursor advanced only for durable pages');
        assert.equal(s.committedPageRows, committed);
        assert.equal(s.orphanObservations, 0, 'no records from an uncommitted page');
        assert.deepEqual(s.sourceIds, idsOfFirstPages(committed), 'exactly the committed pages are present');

        const blocked = runWorker(path, 'owner-b', T0 + 1_000);
        assert.equal(blocked.status, 3, 'unexpired lease blocks a second capture owner');

        const resumed = runWorker(path, 'owner-b', T0 + 120_000);
        assert.equal(resumed.status, 0, resumed.stderr);
        assertComplete(path);
      });
    });
  }
}

test('T01 replaying every committed page is a no-op', () => {
  withDb((path) => {
    assert.equal(runWorker(path, 'owner-a', T0).status, 0);
    const before = snapshot(path);
    const db = openStore(path);
    assert.ok(acquireLease(db, 'job-1', 'owner-a', T0, 60_000));
    for (const page of allPages()) {
      assert.equal(commitPage(db, 'job-1', 'owner-a', T0, page).status, 'replayed');
    }
    db.close();
    assert.deepEqual(snapshot(path), before);
  });
});

test('a replayed page with a different continuation is rejected, not merged', () => {
  withDb((path) => {
    const db = openStore(path);
    createJob(db, 'job-1', ACCOUNT, COLLECTION);
    acquireLease(db, 'job-1', 'owner-a', T0, 60_000);
    const [first] = allPages();
    commitPage(db, 'job-1', 'owner-a', T0, first);
    assert.throws(() => commitPage(db, 'job-1', 'owner-a', T0, { ...first, cursorOut: 'cur-9' as never }), CursorMismatchError);
    assert.throws(() => commitPage(db, 'job-1', 'owner-a', T0, allPages()[2]), CursorMismatchError, 'cannot skip a page');
    assert.equal(readJob(db, 'job-1').pagesCommitted, 1);
    db.close();
  });
});

test('a capture owner whose lease was taken over cannot commit', () => {
  withDb((path) => {
    const db = openStore(path);
    createJob(db, 'job-1', ACCOUNT, COLLECTION);
    assert.ok(acquireLease(db, 'job-1', 'owner-a', T0, 60_000));
    assert.ok(!acquireLease(db, 'job-1', 'owner-b', T0 + 1, 60_000));
    assert.ok(acquireLease(db, 'job-1', 'owner-b', T0 + 61_000, 60_000));
    assert.throws(() => commitPage(db, 'job-1', 'owner-a', T0 + 61_001, allPages()[0]), LeaseLostError);
    assert.equal(readJob(db, 'job-1').started, false);
    db.close();
  });
});

test('a second job for the same account and collection cannot take a lease while the first is live', () => {
  withDb((path) => {
    const db = openStore(path);
    createJob(db, 'job-1', ACCOUNT, COLLECTION);
    createJob(db, 'job-2', ACCOUNT, COLLECTION);
    createJob(db, 'job-3', ACCOUNT, 'x:collection:other');
    assert.ok(acquireLease(db, 'job-1', 'owner-a', T0, 60_000));
    assert.ok(!acquireLease(db, 'job-2', 'owner-b', T0 + 1, 60_000));
    assert.throws(() => commitPage(db, 'job-2', 'owner-b', T0 + 2, allPages()[0]), LeaseLostError);
    assert.ok(acquireLease(db, 'job-3', 'owner-b', T0 + 1, 60_000));
    assert.ok(acquireLease(db, 'job-2', 'owner-b', T0 + 61_000, 60_000));
    db.close();
  });
});

test('a page from a different account is refused before any write (CAP-02)', () => {
  withDb((path) => {
    const db = openStore(path);
    createJob(db, 'job-1', ACCOUNT, COLLECTION);
    acquireLease(db, 'job-1', 'owner-a', T0, 60_000);
    assert.throws(() => commitPage(db, 'job-1', 'owner-a', T0, { ...allPages()[0], accountId: 'x:account:2' }), AccountMismatchError);
    db.close();
    assert.equal(snapshot(path).sources, 0);
  });
});

test('identical text under different platform ids stays distinct; changed text adds a version', () => {
  withDb((path) => {
    assert.equal(runWorker(path, 'owner-a', T0).status, 0);
    const db = new DatabaseSync(path, { readOnly: true });
    const shared = db.prepare("SELECT count(DISTINCT source_id) n FROM source_version WHERE text = 'Identical text shared by distinct posts.'").get() as { n: number };
    assert.ok(shared.n > 1);
    const multi = db.prepare('SELECT count(*) n FROM (SELECT source_id FROM source_version GROUP BY source_id HAVING count(*) > 1)').get() as { n: number };
    assert.ok(multi.n > 0, 'an observed text change is kept as a second version');
    db.close();
  });
});
