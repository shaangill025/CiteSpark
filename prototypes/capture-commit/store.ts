import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

export type PlatformId = string & { readonly __brand: 'PlatformId' };
export type Cursor = string & { readonly __brand: 'Cursor' };

export interface CapturedPost {
  platformId: PlatformId;
  authorId: string;
  text: string;
  publishedAt: string;
}

export interface CapturePage {
  accountId: string;
  collectionId: string;
  cursorIn: Cursor | null;
  cursorOut: Cursor | null;
  records: CapturedPost[];
}

export type CommitResult =
  | { status: 'committed'; cursor: Cursor | null; newVersions: number }
  | { status: 'replayed'; cursor: Cursor | null };

export class LeaseLostError extends Error {}
export class CursorMismatchError extends Error {}
export class AccountMismatchError extends Error {}

export type CrashPoint = 'mid-page' | 'before-commit' | 'after-commit';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS source (
  id TEXT PRIMARY KEY,
  platform_id TEXT NOT NULL,
  author_id TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS source_version (
  id INTEGER PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES source(id),
  content_hash TEXT NOT NULL,
  text TEXT NOT NULL,
  published_at TEXT NOT NULL,
  UNIQUE (source_id, content_hash)
) STRICT;
CREATE TABLE IF NOT EXISTS observation (
  version_id INTEGER NOT NULL REFERENCES source_version(id),
  job_id TEXT NOT NULL,
  page_key TEXT NOT NULL,
  PRIMARY KEY (job_id, page_key, version_id)
) STRICT;
CREATE TABLE IF NOT EXISTS membership (
  account_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  source_id TEXT NOT NULL REFERENCES source(id),
  first_job_id TEXT NOT NULL,
  last_job_id TEXT NOT NULL,
  PRIMARY KEY (account_id, collection_id, source_id)
) STRICT;
CREATE TABLE IF NOT EXISTS job (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  collection_id TEXT NOT NULL,
  cursor TEXT,
  started INTEGER NOT NULL DEFAULT 0,
  finished INTEGER NOT NULL DEFAULT 0,
  pages_committed INTEGER NOT NULL DEFAULT 0,
  lease_owner TEXT,
  lease_expires_at INTEGER
) STRICT;
CREATE TABLE IF NOT EXISTS committed_page (
  job_id TEXT NOT NULL REFERENCES job(id),
  page_key TEXT NOT NULL,
  cursor_out TEXT,
  PRIMARY KEY (job_id, page_key)
) STRICT;
`;

export function openStore(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export function createJob(db: DatabaseSync, jobId: string, accountId: string, collectionId: string): void {
  db.prepare('INSERT OR IGNORE INTO job (id, account_id, collection_id) VALUES (?, ?, ?)').run(jobId, accountId, collectionId);
}

export function acquireLease(db: DatabaseSync, jobId: string, owner: string, nowMs: number, ttlMs: number): boolean {
  const r = db
    .prepare(
      `UPDATE job SET lease_owner = ?, lease_expires_at = ?
       WHERE id = ? AND (lease_owner IS NULL OR lease_owner = ? OR lease_expires_at < ?)`,
    )
    .run(owner, nowMs + ttlMs, jobId, owner, nowMs);
  return r.changes === 1;
}

export interface JobState {
  cursor: Cursor | null;
  started: boolean;
  finished: boolean;
  pagesCommitted: number;
}

export function readJob(db: DatabaseSync, jobId: string): JobState {
  const row = db.prepare('SELECT cursor, started, finished, pages_committed FROM job WHERE id = ?').get(jobId) as
    | { cursor: string | null; started: number; finished: number; pages_committed: number }
    | undefined;
  if (!row) throw new Error(`unknown job ${jobId}`);
  return {
    cursor: row.cursor as Cursor | null,
    started: row.started === 1,
    finished: row.finished === 1,
    pagesCommitted: row.pages_committed,
  };
}

const pageKey = (cursorIn: Cursor | null): string => cursorIn ?? '<start>';
const sourceIdOf = (p: CapturedPost): string => `x:post:${p.platformId}`;
const hashText = (t: string): string => createHash('sha256').update(t, 'utf8').digest('hex');

/**
 * Persists one page and advances the job cursor in a single transaction.
 * The cursor moves only when every record of the page is durable, and a page
 * that was already committed is acknowledged without writing anything.
 */
export function commitPage(
  db: DatabaseSync,
  jobId: string,
  leaseOwner: string,
  nowMs: number,
  page: CapturePage,
  crashAt?: CrashPoint,
): CommitResult {
  db.exec('BEGIN IMMEDIATE');
  try {
    const job = db
      .prepare('SELECT account_id, collection_id, cursor, started, finished, lease_owner, lease_expires_at FROM job WHERE id = ?')
      .get(jobId) as {
      account_id: string;
      collection_id: string;
      cursor: string | null;
      started: number;
      finished: number;
      lease_owner: string | null;
      lease_expires_at: number | null;
    };
    if (job.lease_owner !== leaseOwner || (job.lease_expires_at ?? 0) < nowMs) {
      throw new LeaseLostError(`lease for ${jobId} not held by ${leaseOwner}`);
    }
    if (job.account_id !== page.accountId || job.collection_id !== page.collectionId) {
      throw new AccountMismatchError(`page belongs to ${page.accountId}/${page.collectionId}`);
    }

    const key = pageKey(page.cursorIn);
    const prior = db.prepare('SELECT cursor_out FROM committed_page WHERE job_id = ? AND page_key = ?').get(jobId, key) as
      | { cursor_out: string | null }
      | undefined;
    if (prior) {
      if (prior.cursor_out !== page.cursorOut) {
        throw new CursorMismatchError(`page ${key} replayed with a different continuation`);
      }
      db.exec('COMMIT');
      return { status: 'replayed', cursor: job.cursor as Cursor | null };
    }
    const expectedIn = job.started === 1 ? job.cursor : null;
    if (job.finished === 1 || expectedIn !== page.cursorIn) {
      throw new CursorMismatchError(`job cursor is ${job.cursor}, page starts at ${page.cursorIn}`);
    }

    const insSource = db.prepare('INSERT OR IGNORE INTO source (id, platform_id, author_id) VALUES (?, ?, ?)');
    const insVersion = db.prepare(
      'INSERT OR IGNORE INTO source_version (source_id, content_hash, text, published_at) VALUES (?, ?, ?, ?)',
    );
    const getVersion = db.prepare('SELECT id FROM source_version WHERE source_id = ? AND content_hash = ?');
    const insObservation = db.prepare('INSERT OR IGNORE INTO observation (version_id, job_id, page_key) VALUES (?, ?, ?)');
    const upMembership = db.prepare(
      `INSERT INTO membership (account_id, collection_id, source_id, first_job_id, last_job_id) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (account_id, collection_id, source_id) DO UPDATE SET last_job_id = excluded.last_job_id`,
    );

    let newVersions = 0;
    page.records.forEach((post, i) => {
      if (crashAt === 'mid-page' && i === Math.floor(page.records.length / 2)) process.kill(process.pid, 'SIGKILL');
      const sid = sourceIdOf(post);
      insSource.run(sid, post.platformId, post.authorId);
      const h = hashText(post.text);
      newVersions += Number(insVersion.run(sid, h, post.text, post.publishedAt).changes);
      const { id } = getVersion.get(sid, h) as { id: number };
      insObservation.run(id, jobId, key);
      upMembership.run(page.accountId, page.collectionId, sid, jobId, jobId);
    });

    db.prepare('INSERT INTO committed_page (job_id, page_key, cursor_out) VALUES (?, ?, ?)').run(jobId, key, page.cursorOut);
    db.prepare(
      'UPDATE job SET cursor = ?, started = 1, finished = ?, pages_committed = pages_committed + 1 WHERE id = ?',
    ).run(page.cursorOut, page.cursorOut === null ? 1 : 0, jobId);

    if (crashAt === 'before-commit') process.kill(process.pid, 'SIGKILL');
    db.exec('COMMIT');
    if (crashAt === 'after-commit') process.kill(process.pid, 'SIGKILL');
    return { status: 'committed', cursor: page.cursorOut, newVersions };
  } catch (err) {
    if (db.isTransaction) db.exec('ROLLBACK');
    throw err;
  }
}
