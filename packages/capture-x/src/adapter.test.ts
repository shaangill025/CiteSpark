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

function okPage(name: string, collection: CollectionRef = bookmarks): ParsedPage {
  const result = xAdapter.parsePage(fixture(name), collection);
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
