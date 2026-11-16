export const ADAPTER_ID = "x-web";
export const ADAPTER_VERSION = "1.0.0";

export type CollectionRef =
  { kind: "bookmarks" } | { kind: "likes" } | { kind: "bookmark_folder"; folderId: string };

export type CollectionInfo =
  | { kind: "bookmarks" }
  | { kind: "likes" }
  | { kind: "bookmark_folder"; folderId: string; name: string };

export interface AccountIdentity {
  accountId: string;
  handle: string;
}

export interface PostAuthor {
  id: string;
  handle: string;
}

export interface Translation {
  text: string;
  sourceLanguage: string | null;
  targetLanguage: string | null;
  origin: "x-translation";
}

export interface QuotedPost {
  id: string;
  unavailable: boolean;
  author: PostAuthor | null;
  text: string | null;
  language: string | null;
  createdAt: string | null;
}

export interface ThreadPlacement {
  rootId: string;
  sequence: number | null;
  membership: "confirmed" | "uncertain";
}

export interface CapturedPost {
  id: string;
  role: "root" | "thread_continuation";
  author: PostAuthor;
  /** Author-original text. Never replaced by a translation. */
  text: string;
  language: string | null;
  createdAt: string;
  conversationId: string | null;
  inReplyToId: string | null;
  quoted: QuotedPost | null;
  translation: Translation | null;
  thread: ThreadPlacement | null;
}

export interface ThreadObservation {
  /** Opening post ID. When the opening post is unavailable this is X's conversation ID (or the
   * first surviving post's parent) and `flags` contains `root_unavailable`. */
  rootId: string;
  postIds: string[];
  excludedReplyIds: string[];
  /** Module entries X delivered as tombstones; their positions are gaps in the thread. */
  unavailableEntryIds: string[];
  flags: string[];
}

export interface UnavailableEntry {
  entryId: string;
  reason: "tombstone";
}

export interface ParsedPage {
  adapterVersion: string;
  collection: CollectionRef;
  posts: CapturedPost[];
  threads: ThreadObservation[];
  unavailable: UnavailableEntry[];
  cursorOut: string | null;
  /** True only when X explicitly terminated the bottom of the timeline or delivered no bottom
   * cursor. Tombstone-only and cursor-only pages are not exhausted. */
  exhausted: boolean;
}

export type ParseResult =
  | { status: "ok"; page: ParsedPage }
  | {
      status: "paused";
      /** `control_only`: the body held no page entries and no termination, so it is no evidence
       * that the collection ended (CAP-06). */
      reason: "unsupported_schema" | "control_only";
      detail: string;
      adapterVersion: string;
    };

export type NextStep = { kind: "scroll"; expectCursor: string } | { kind: "end" };

/** Passive capture: the adapter never builds a request or touches credentials (ADR 0005). */
export interface CaptureAdapter {
  readonly id: string;
  readonly version: string;
  detectAccount(body: unknown): AccountIdentity | null;
  listCollections(body: unknown): CollectionInfo[];
  parsePage(body: unknown, collection: CollectionRef): ParseResult;
  nextRequest(page: ParsedPage): NextStep;
}
