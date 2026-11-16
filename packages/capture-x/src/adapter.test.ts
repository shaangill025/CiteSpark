import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  ADAPTER_ID,
  ADAPTER_VERSION,
  xAdapter,
  type CollectionRef,
  type ParsedPage,
} from "./index.ts";

function fixture(name: string): unknown {
  const url = new URL(`../../../fixtures/x/${name}`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8"));
}

const bookmarks: CollectionRef = { kind: "bookmarks" };

function okPage(source: string | object, collection: CollectionRef = bookmarks): ParsedPage {
  const body = typeof source === "string" ? fixture(source) : source;
  const result = xAdapter.parsePage(body, collection);
  if (result.status !== "ok") throw new Error(`expected ok, got ${result.status}`);
  return result.page;
}

function post(page: ParsedPage, id: string) {
  const found = page.posts.find((p) => p.id === id);
  if (!found) throw new Error(`post ${id} missing`);
  return found;
}

describe("adapter identity (CAP-01)", () => {
  test("is versioned and replaceable", () => {
    expect(xAdapter.id).toBe(ADAPTER_ID);
    expect(xAdapter.version).toBe(ADAPTER_VERSION);
    expect(okPage("bookmarks-page1.json").adapterVersion).toBe(ADAPTER_VERSION);
  });

  test("detects the signed-in account as string IDs", () => {
    expect(xAdapter.detectAccount(fixture("viewer.json"))).toEqual({
      accountId: "7000000000000000001",
      handle: "synth_alice",
    });
    expect(xAdapter.detectAccount({ data: {} })).toBeNull();
  });

  test("lists bookmarks, likes, and each bookmark folder (Q15)", () => {
    const list = xAdapter.listCollections(fixture("bookmark-folders.json"));
    expect(list).toEqual([
      { kind: "bookmarks" },
      { kind: "likes" },
      { kind: "bookmark_folder", folderId: "1800000000000000001", name: "Synthetic reading list" },
      { kind: "bookmark_folder", folderId: "1800000000000000002", name: "Synthetic recipes" },
    ]);
  });
});

describe("bookmarks page parsing", () => {
  const page = okPage("bookmarks-page1.json");

  test("keeps collection order and 19-digit IDs exactly", () => {
    expect(page.posts.map((p) => p.id)).toEqual([
      "1900000000000000101",
      "1900000000000000102",
      "1900000000000000104",
      "1900000000000000201",
      "1900000000000000202",
      "1900000000000000204",
      "1900000000000000205",
    ]);
    expect(post(page, "1900000000000000101").author.id).toBe("7000000000000000001");
  });

  test("prefers long-form text over the truncated legacy text", () => {
    expect(post(page, "1900000000000000101").text).toBe(
      "Synthetic long-form post body that is longer than the short legacy text.",
    );
  });

  test("returns cursors and does not claim exhaustion mid-collection", () => {
    expect(page.cursorOut).toBe("SYNTHETIC_BOTTOM_CURSOR_1");
    expect(page.exhausted).toBe(false);
    expect(okPage("bookmarks-last-page.json").exhausted).toBe(true);
  });

  test("records unavailable posts instead of dropping them silently", () => {
    expect(page.unavailable).toEqual([
      { entryId: "tweet-1900000000000000301", reason: "tombstone" },
    ]);
  });
});

describe("T03 capture part: root, quote, translation, thread stay distinct", () => {
  const page = okPage("bookmarks-page1.json");

  test("a quote is nested under its quoting root, not a top-level post", () => {
    const root = post(page, "1900000000000000102");
    expect(root.role).toBe("root");
    expect(root.text).toBe("Alice's commentary on Bob's post.");
    expect(root.quoted).toMatchObject({
      id: "1900000000000000103",
      author: { id: "7000000000000000002", handle: "synth_bob" },
      text: "Bob's original quoted statement.",
    });
    expect(page.posts.some((p) => p.id === "1900000000000000103")).toBe(false);
  });

  test("translation is a separate labelled field; text stays original", () => {
    const p = post(page, "1900000000000000104");
    expect(p.text).toBe("これは合成データのテスト投稿です。");
    expect(p.language).toBe("ja");
    expect(p.translation).toEqual({
      text: "This is a synthetic test post.",
      sourceLanguage: "ja",
      targetLanguage: "en",
      origin: "x-translation",
    });
    expect(post(page, "1900000000000000101").translation).toBeNull();
  });
});

describe("thread continuations (CAP-08, Q17)", () => {
  const page = okPage("bookmarks-page1.json");

  test("confirmed continuations keep identity and chain order", () => {
    const root = post(page, "1900000000000000201");
    const second = post(page, "1900000000000000202");
    const third = post(page, "1900000000000000204");
    expect(root.role).toBe("root");
    expect(root.thread).toMatchObject({ rootId: "1900000000000000201", sequence: 0 });
    expect(second.role).toBe("thread_continuation");
    expect(second.inReplyToId).toBe("1900000000000000201");
    expect(second.thread).toMatchObject({ sequence: 1, membership: "confirmed" });
    expect(third.thread).toMatchObject({ sequence: 2, membership: "confirmed" });
  });

  test("other authors' replies are excluded by default and listed", () => {
    expect(page.posts.some((p) => p.id === "1900000000000000203")).toBe(false);
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]).toMatchObject({
      rootId: "1900000000000000201",
      excludedReplyIds: ["1900000000000000203"],
    });
  });

  test("same author without relationship evidence is flagged, not trusted", () => {
    const orphan = post(page, "1900000000000000205");
    expect(orphan.role).toBe("thread_continuation");
    expect(orphan.thread?.membership).toBe("uncertain");
    expect(page.threads[0]?.flags).toContain("missing_parent:1900000000000000999");
    expect(page.threads[0]?.flags).toContain("uncertain_membership:1900000000000000205");
  });
});

describe("other collections", () => {
  test("parses a bookmark folder page", () => {
    const page = okPage("bookmark-folder-page.json", {
      kind: "bookmark_folder",
      folderId: "1800000000000000001",
    });
    expect(page.collection).toEqual({ kind: "bookmark_folder", folderId: "1800000000000000001" });
    expect(page.posts.map((p) => p.id)).toEqual(["1900000000000000401"]);
    expect(page.cursorOut).toBe("SYNTHETIC_FOLDER_CURSOR_1");
  });

  test("parses a likes page", () => {
    const page = okPage("likes-page.json", { kind: "likes" });
    expect(page.posts.map((p) => p.id)).toEqual(["1900000000000000501"]);
  });

  test("a body for a different collection is not accepted", () => {
    const result = xAdapter.parsePage(fixture("likes-page.json"), bookmarks);
    expect(result.status).toBe("paused");
  });
});

describe("unsupported schema pauses, never completes (CAP-07)", () => {
  test("unknown timeline root", () => {
    const result = xAdapter.parsePage(fixture("schema-changed.json"), bookmarks);
    expect(result).toMatchObject({
      status: "paused",
      reason: "unsupported_schema",
      adapterVersion: ADAPTER_VERSION,
    });
  });

  test("a tweet missing required fields", () => {
    const result = xAdapter.parsePage(fixture("tweet-missing-fields.json"), bookmarks);
    expect(result).toMatchObject({ status: "paused", reason: "unsupported_schema" });
  });

  test.each([null, 42, "text", [], {}])("garbage body %j", (body) => {
    expect(xAdapter.parsePage(body, bookmarks).status).toBe("paused");
  });

  test("an unknown entry type is not silently skipped", () => {
    const body = {
      data: {
        bookmark_timeline_v2: {
          timeline: {
            instructions: [
              {
                type: "TimelineAddEntries",
                entries: [{ entryId: "x-1", content: { entryType: "TimelineSynthetic" } }],
              },
            ],
          },
        },
      },
    };
    expect(xAdapter.parsePage(body, bookmarks).status).toBe("paused");
  });
});

describe("passive capture (ADR 0005)", () => {
  test("nextRequest never builds a request; it only asks for more scrolling or ends", () => {
    expect(xAdapter.nextRequest(okPage("bookmarks-page1.json"))).toEqual({
      kind: "scroll",
      expectCursor: "SYNTHETIC_BOTTOM_CURSOR_1",
    });
    expect(xAdapter.nextRequest(okPage("bookmarks-last-page.json"))).toEqual({ kind: "end" });
  });
});

// Synthetic builders for review regressions (no real X data).
const ALICE = { rest_id: "7000000000000000001", legacy: { screen_name: "synth_alice" } };

function tweet(id: string, inReplyTo: string | null, conversation: string): unknown {
  return {
    __typename: "Tweet",
    rest_id: id,
    core: { user_results: { result: ALICE } },
    legacy: {
      full_text: `Synthetic post ${id}`,
      lang: "en",
      created_at: "Wed Jan 07 10:00:00 +0000 2026",
      conversation_id_str: conversation,
      ...(inReplyTo === null
        ? {}
        : { in_reply_to_status_id_str: inReplyTo, in_reply_to_user_id_str: ALICE.rest_id }),
    },
  };
}

const TOMBSTONE = { __typename: "TweetTombstone", tombstone: { text: { text: "Unavailable." } } };

function itemEntry(entryId: string, result: unknown): unknown {
  return {
    entryId,
    content: {
      entryType: "TimelineTimelineItem",
      itemContent: { itemType: "TimelineTweet", tweet_results: { result } },
    },
  };
}

function moduleEntry(entryId: string, items: [string, unknown][]): unknown {
  return {
    entryId,
    content: {
      entryType: "TimelineTimelineModule",
      items: items.map(([id, result]) => ({
        entryId: id,
        item: { itemContent: { itemType: "TimelineTweet", tweet_results: { result } } },
      })),
    },
  };
}

function cursor(type: "Top" | "Bottom", value: string): unknown {
  return {
    entryId: `cursor-${type.toLowerCase()}-${value}`,
    content: { entryType: "TimelineTimelineCursor", cursorType: type, value },
  };
}

function bookmarksBody(instructions: unknown[]): unknown {
  return { data: { bookmark_timeline_v2: { timeline: { instructions } } } };
}

describe("termination evidence (CAP-06, CAP-07 review regressions)", () => {
  test("a cache-control-only response pauses instead of claiming exhaustion", () => {
    const result = xAdapter.parsePage(bookmarksBody([{ type: "TimelineClearCache" }]), bookmarks);
    expect(result.status).toBe("paused");
  });

  test("an empty instruction list pauses instead of claiming exhaustion", () => {
    expect(xAdapter.parsePage(bookmarksBody([]), bookmarks).status).toBe("paused");
  });

  test("a tombstone-only page with a bottom cursor keeps scrolling", () => {
    const body = bookmarksBody([
      {
        type: "TimelineAddEntries",
        entries: [
          itemEntry("tweet-1900000000000000601", TOMBSTONE),
          cursor("Bottom", "SYNTHETIC_AFTER_TOMBSTONES"),
        ],
      },
    ]);
    const page = okPage(body);
    expect(page.posts).toEqual([]);
    expect(page.unavailable).toEqual([
      { entryId: "tweet-1900000000000000601", reason: "tombstone" },
    ]);
    expect(page.exhausted).toBe(false);
    expect(xAdapter.nextRequest(page)).toEqual({
      kind: "scroll",
      expectCursor: "SYNTHETIC_AFTER_TOMBSTONES",
    });
  });

  test("an explicit bottom termination ends even with a cursor present", () => {
    const body = bookmarksBody([
      {
        type: "TimelineAddEntries",
        entries: [
          itemEntry(
            "tweet-1900000000000000611",
            tweet("1900000000000000611", null, "1900000000000000611"),
          ),
          cursor("Bottom", "SYNTHETIC_TERMINATED"),
        ],
      },
      { type: "TimelineTerminateTimeline", direction: "Bottom" },
    ]);
    expect(okPage(body).exhausted).toBe(true);
  });
});

describe("unavailable thread ancestry (CAP-08 review regressions)", () => {
  test("a tombstoned opening post is not replaced by the first surviving reply", () => {
    const body = bookmarksBody([
      {
        type: "TimelineAddEntries",
        entries: [
          moduleEntry("conversationthread-1900000000000000701", [
            ["conversationthread-1900000000000000701-tweet-1900000000000000701", TOMBSTONE],
            [
              "conversationthread-1900000000000000701-tweet-1900000000000000702",
              tweet("1900000000000000702", "1900000000000000701", "1900000000000000701"),
            ],
            [
              "conversationthread-1900000000000000701-tweet-1900000000000000703",
              tweet("1900000000000000703", "1900000000000000702", "1900000000000000701"),
            ],
          ]),
          cursor("Bottom", "SYNTHETIC_THREAD_CURSOR"),
        ],
      },
    ]);
    const page = okPage(body);
    const first = post(page, "1900000000000000702");
    expect(first.role).toBe("thread_continuation");
    expect(first.thread).toMatchObject({ rootId: "1900000000000000701", membership: "uncertain" });
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]).toMatchObject({
      rootId: "1900000000000000701",
      unavailableEntryIds: ["conversationthread-1900000000000000701-tweet-1900000000000000701"],
    });
    expect(page.threads[0]?.flags).toContain("missing_parent:1900000000000000701");
  });

  test("the gap observation survives when only one available item remains", () => {
    const body = bookmarksBody([
      {
        type: "TimelineAddEntries",
        entries: [
          moduleEntry("conversationthread-1900000000000000801", [
            ["conversationthread-1900000000000000801-tweet-1900000000000000801", TOMBSTONE],
            [
              "conversationthread-1900000000000000801-tweet-1900000000000000802",
              tweet("1900000000000000802", "1900000000000000801", "1900000000000000801"),
            ],
          ]),
          cursor("Bottom", "SYNTHETIC_GAP_CURSOR"),
        ],
      },
    ]);
    const page = okPage(body);
    expect(post(page, "1900000000000000802").role).toBe("thread_continuation");
    expect(page.threads).toHaveLength(1);
    expect(page.threads[0]?.flags).toContain("missing_parent:1900000000000000801");
    expect(page.threads[0]?.unavailableEntryIds).toEqual([
      "conversationthread-1900000000000000801-tweet-1900000000000000801",
    ]);
  });
});
