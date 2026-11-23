// Synthetic X GraphQL responses for tests and the T02 browser harness. Invented IDs, handles and text
// only; shapes follow the documented fixtures in fixtures/x (ADR 0005). Never real X data.

export const SYNTH_ACCOUNT = "7000000000000000001";
export const SYNTH_HANDLE = "synth_alice";
export const OTHER_ACCOUNT = "7000000000000000999";

export const postId = (n: number) => `19${String(n).padStart(17, "0")}`;

export interface PageSpec {
  /** Post numbers on this page. */
  posts: number[];
  /** Bottom cursor for the next page; omitted at the end of the collection. */
  next: string | null;
  /** Add a tombstoned entry (an unavailable post: a gap). */
  tombstone?: boolean;
  /** Add a thread module whose opening post is missing (a partial thread: a gap). */
  partialThread?: boolean;
  /** Replace the payload with an unrecognized shape (an X change, CAP-07). */
  unsupported?: boolean;
  /** Repeat each post's text this many times (large pages for the disk-full scenario). */
  textRepeat?: number;
}

const tweet = (n: number, extra: Record<string, unknown> = {}, repeat = 1) => ({
  __typename: "Tweet",
  rest_id: postId(n),
  core: {
    user_results: {
      result: { rest_id: "7000000000000000002", legacy: { screen_name: "synth_bob" } },
    },
  },
  legacy: {
    full_text: `Synthetic bookmarked post number ${n}`.repeat(repeat),
    lang: "en",
    created_at: "Wed Jan 01 00:00:00 +0000 2025",
    conversation_id_str: postId(n),
    ...extra,
  },
});

const item = (n: number, repeat = 1) => ({
  entryId: `tweet-${postId(n)}`,
  sortIndex: String(9_000_000 - n),
  content: {
    entryType: "TimelineTimelineItem",
    itemContent: { itemType: "TimelineTweet", tweet_results: { result: tweet(n, {}, repeat) } },
  },
});

const cursor = (type: "Top" | "Bottom", value: string) => ({
  entryId: `cursor-${type.toLowerCase()}-${value}`,
  content: { entryType: "TimelineTimelineCursor", cursorType: type, value },
});

export function bookmarksBody(spec: PageSpec): unknown {
  if (spec.unsupported) {
    return { data: { bookmark_timeline_v3: { items: spec.posts.map(postId) } } };
  }
  const entries: unknown[] = spec.posts.map((n) => item(n, spec.textRepeat ?? 1));
  if (spec.tombstone) {
    entries.push({
      entryId: `tweet-tomb-${spec.posts[0] ?? 0}`,
      sortIndex: "1",
      content: {
        entryType: "TimelineTimelineItem",
        itemContent: {
          itemType: "TimelineTweet",
          tweet_results: { result: { __typename: "TweetTombstone" } },
        },
      },
    });
  }
  if (spec.partialThread) {
    const base = 900 + (spec.posts[0] ?? 0);
    const reply = {
      ...tweet(base, {
        conversation_id_str: postId(base - 1),
        in_reply_to_status_id_str: postId(base - 1),
        in_reply_to_user_id_str: "7000000000000000002",
      }),
    };
    entries.push({
      entryId: `conversationthread-${postId(base)}`,
      sortIndex: "2",
      content: {
        entryType: "TimelineTimelineModule",
        items: [
          {
            entryId: `conversationthread-${postId(base)}-tweet-${postId(base)}`,
            item: {
              itemContent: { itemType: "TimelineTweet", tweet_results: { result: reply } },
            },
          },
        ],
      },
    });
  }
  entries.push(cursor("Top", "SYNTH_TOP"));
  if (spec.next !== null) entries.push(cursor("Bottom", spec.next));
  return {
    data: {
      bookmark_timeline_v2: {
        timeline: { instructions: [{ type: "TimelineAddEntries", entries }] },
      },
    },
  };
}

export const viewerBody = (accountId = SYNTH_ACCOUNT, handle = SYNTH_HANDLE) => ({
  data: {
    viewer: { user_results: { result: { rest_id: accountId, legacy: { screen_name: handle } } } },
  },
});

/** A linear collection of `pages` pages with `perPage` posts each; cursors are opaque. */
export function linearCollection(pages: number, perPage: number, pass = "A"): PageSpec[] {
  return Array.from({ length: pages }, (_, i) => ({
    posts: Array.from({ length: perPage }, (_, j) => i * perPage + j),
    next: i === pages - 1 ? null : `SYNTH_${pass}_CURSOR_${i + 1}`,
  }));
}

export const bookmarksUrl = (cursor: string | null) =>
  `https://x.com/i/api/graphql/SynthQueryBookmarks/Bookmarks?variables=${encodeURIComponent(
    JSON.stringify(cursor === null ? { count: 20 } : { count: 20, cursor }),
  )}`;
