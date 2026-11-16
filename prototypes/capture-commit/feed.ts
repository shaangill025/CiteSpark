import type { CapturePage, CapturedPost, Cursor, PlatformId } from './store.ts';

export const ACCOUNT = 'x:account:1000000000000000001';
export const COLLECTION = 'x:bookmarks';
export const PAGE_COUNT = 12;
const PAGE_SIZE = 50;
const STRIDE = 45;

const platformId = (n: number): PlatformId => `18${String(n).padStart(17, '0')}` as PlatformId;
const cursorFor = (page: number): Cursor | null => (page === 0 ? null : (`cur-${page}` as Cursor));

function post(n: number, page: number): CapturedPost {
  const edited = n % STRIDE === 2 && page % 2 === 1;
  const sharedText = n % 50 === 7;
  const text = sharedText ? 'Identical text shared by distinct posts.' : `Synthetic post ${n}${edited ? ' (edited)' : ''}`;
  return { platformId: platformId(n), authorId: `x:user:${n % 13}`, text, publishedAt: new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString() };
}

/** Deterministic synthetic feed. Adjacent pages overlap, as a live timeline does. */
export function pageAt(cursor: Cursor | null): CapturePage {
  const page = cursor === null ? 0 : Number(cursor.slice('cur-'.length));
  const records = Array.from({ length: PAGE_SIZE }, (_, i) => post(page * STRIDE + i, page));
  return {
    accountId: ACCOUNT,
    collectionId: COLLECTION,
    cursorIn: cursorFor(page),
    cursorOut: page === PAGE_COUNT - 1 ? null : (`cur-${page + 1}` as Cursor),
    records,
  };
}

export const allPages = (): CapturePage[] => Array.from({ length: PAGE_COUNT }, (_, p) => pageAt(cursorFor(p)));

export function expectedDistinctPosts(): number {
  return new Set(allPages().flatMap((p) => p.records.map((r) => r.platformId))).size;
}

export function expectedDistinctVersions(): number {
  return new Set(allPages().flatMap((p) => p.records.map((r) => `${r.platformId}\u0000${r.text}`))).size;
}
