// Deterministic synthetic capture feed for tests. No real account, post, or user data.
import type { CapturePage, CaptureRecord } from "../capture.ts";

export const ACCOUNT = "x:account:1000000000000000001";
export const COLLECTION = "x:bookmarks";
export const ADAPTER = { id: "synthetic", version: "1.0.0" } as const;
export const PAGE_COUNT = 12;
const PAGE_SIZE = 50;
const STRIDE = 45;
export const SHARED_TEXT = "Identical text shared by distinct posts.";

// 19-digit IDs exceed Number.MAX_SAFE_INTEGER, so precision loss would merge identities.
const platformId = (n: number): string => `18${String(n).padStart(17, "0")}`;

function record(n: number, page: number): CaptureRecord {
  const edited = n % STRIDE === 2 && page % 2 === 1;
  const text =
    n % PAGE_SIZE === 7 ? SHARED_TEXT : `Synthetic post ${n}${edited ? " (edited)" : ""}`;
  return {
    sourceType: "x_post",
    platformId: platformId(n),
    authorId: `x:user:${n % 13}`,
    text,
    publishedAt: new Date(Date.UTC(2025, 0, 1) + n * 60_000).toISOString(),
  };
}

/** Cursors are opaque and differ per pass, as X issues new cursors on every scroll from the top. */
export const cursorFor = (passId: string, page: number): string | null =>
  page === 0 ? null : `${passId}/cur-${page}`;

/** Page `page` of the collection as seen by pass `passId`. Adjacent pages overlap, as a live timeline does. */
export function pageAt(passId: string, page: number): CapturePage {
  return {
    passId,
    accountId: ACCOUNT,
    collectionId: COLLECTION,
    adapter: ADAPTER,
    cursorIn: cursorFor(passId, page),
    cursorOut: page === PAGE_COUNT - 1 ? null : cursorFor(passId, page + 1),
    records: Array.from({ length: PAGE_SIZE }, (_, i) => record(page * STRIDE + i, page)),
  };
}

export const allPages = (passId: string): CapturePage[] =>
  Array.from({ length: PAGE_COUNT }, (_, p) => pageAt(passId, p));

export const platformIdsOfFirstPages = (n: number): Set<string> =>
  new Set(
    allPages("any")
      .slice(0, n)
      .flatMap((p) => p.records.map((r) => r.platformId)),
  );

export const expectedDistinctPosts = (): number => platformIdsOfFirstPages(PAGE_COUNT).size;

export const expectedDistinctVersions = (): number =>
  new Set(allPages("any").flatMap((p) => p.records.map((r) => `${r.platformId}\u0000${r.text}`)))
    .size;
