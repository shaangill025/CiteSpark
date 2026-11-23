import type { CollectionRef, ParsedPage } from "./types.ts";

/**
 * Recognizes X's own GraphQL requests from their URL alone (ADR 0005). Request headers are never an
 * input: the observer must not read cookies, bearer tokens, or CSRF tokens (SEC-04). Anything not
 * recognized here is ignored, including every X operation that could change the account (Q40).
 */
export type RecognizedRequest =
  | { operation: "page"; collection: CollectionRef; cursor: string | null }
  | { operation: "viewer" }
  | { operation: "folders" };

const MAX_URL = 16_384;
const MAX_CURSOR = 4096;
const ID = /^[0-9]{1,25}$/;
const PATH = /^\/i\/api\/graphql\/[A-Za-z0-9_-]{1,64}\/([A-Za-z]{1,64})$/;

function variables(url: URL): Record<string, unknown> | null {
  const raw = url.searchParams.get("variables");
  if (raw === null) return {};
  try {
    const v: unknown = JSON.parse(raw);
    return typeof v === "object" && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function classifyRequest(href: string): RecognizedRequest | null {
  if (typeof href !== "string" || href.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "x.com" || url.port !== "") return null;
  const op = PATH.exec(url.pathname)?.[1];
  if (op === "Viewer") return { operation: "viewer" };
  if (op === "BookmarkFoldersSlice") return { operation: "folders" };
  let collection: CollectionRef;
  const vars = variables(url);
  if (vars === null) return null;
  if (op === "Bookmarks") collection = { kind: "bookmarks" };
  else if (op === "Likes") collection = { kind: "likes" };
  else if (op === "BookmarkFolderTimeline") {
    const folderId = vars["bookmark_collection_id"];
    if (typeof folderId !== "string" || !ID.test(folderId)) return null;
    collection = { kind: "bookmark_folder", folderId };
  } else return null;
  const cursor = vars["cursor"];
  if (cursor === undefined || cursor === null)
    return { operation: "page", collection, cursor: null };
  if (typeof cursor !== "string" || cursor.length === 0 || cursor.length > MAX_CURSOR) return null;
  return { operation: "page", collection, cursor };
}

/** `bookmarks`, `likes`, or `bookmark_folder:<id>`: the collection ID used by the store. */
export function collectionKey(ref: CollectionRef): string {
  return ref.kind === "bookmark_folder" ? `bookmark_folder:${ref.folderId}` : ref.kind;
}

export function parseCollectionKey(key: string): CollectionRef | null {
  if (key === "bookmarks" || key === "likes") return { kind: key };
  const m = /^bookmark_folder:([0-9]{1,25})$/.exec(key);
  return m ? { kind: "bookmark_folder", folderId: m[1]! } : null;
}

export function sameCollection(a: CollectionRef, b: CollectionRef): boolean {
  return collectionKey(a) === collectionKey(b);
}

/** One post as a store capture record; matches `CaptureRecordWire` in @citspark/protocol. */
export interface CaptureRecordOut {
  sourceType: "x_post";
  platformId: string;
  text: string;
  authorId: string | null;
  authorHandle: string | null;
  canonicalUrl: string | null;
  publishedAt: string | null;
}

export interface MappedPage {
  records: CaptureRecordOut[];
  /** `null` only at a recognized end (the adapter's `exhausted`). */
  cursorOut: string | null;
  gaps: { unavailable: number; partialThreads: number };
}

const HANDLE = /^[A-Za-z0-9_]{1,64}$/;

/**
 * Maps a parsed page to capture records. Root posts and thread continuations become records; thread
 * placement, quoted posts, and translations are not stored yet (store schema; M3-11). Gaps are
 * counted so the desktop never ends a pass with gaps as complete (T02).
 */
export function toCaptureRecords(page: ParsedPage): MappedPage {
  const records = page.posts.map((p) => {
    const handle = HANDLE.test(p.author.handle) ? p.author.handle : null;
    return {
      sourceType: "x_post" as const,
      platformId: p.id,
      text: p.text,
      authorId: p.author.id,
      authorHandle: handle,
      canonicalUrl: handle ? `https://x.com/${handle}/status/${p.id}` : null,
      publishedAt: p.createdAt,
    };
  });
  return {
    records,
    cursorOut: page.exhausted ? null : page.cursorOut,
    gaps: {
      unavailable: page.unavailable.length,
      partialThreads: page.threads.filter(
        (t) => t.flags.length > 0 || t.unavailableEntryIds.length > 0,
      ).length,
    },
  };
}
