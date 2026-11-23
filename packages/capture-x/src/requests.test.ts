import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import {
  classifyRequest,
  collectionKey,
  parseCollectionKey,
  toCaptureRecords,
  xAdapter,
  type ParsedPage,
} from "./index.ts";

function fixture(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../../../fixtures/x/${name}`, import.meta.url), "utf8"));
}

const gql = (op: string, variables?: object) =>
  `https://x.com/i/api/graphql/SyntheticQueryId01/${op}` +
  (variables ? `?variables=${encodeURIComponent(JSON.stringify(variables))}&features=%7B%7D` : "");

describe("recognizing X's own collection requests (ADR 0005)", () => {
  test("recognizes the bookmarks timeline and its request cursor", () => {
    expect(classifyRequest(gql("Bookmarks", { count: 20 }))).toEqual({
      operation: "page",
      collection: { kind: "bookmarks" },
      cursor: null,
    });
    expect(classifyRequest(gql("Bookmarks", { count: 20, cursor: "C1" }))).toMatchObject({
      cursor: "C1",
    });
  });

  test("recognizes likes, a bookmark folder by ID, and the viewer", () => {
    expect(classifyRequest(gql("Likes", { userId: "1" }))).toMatchObject({
      collection: { kind: "likes" },
    });
    expect(
      classifyRequest(
        gql("BookmarkFolderTimeline", { bookmark_collection_id: "1800000000000000001" }),
      ),
    ).toMatchObject({ collection: { kind: "bookmark_folder", folderId: "1800000000000000001" } });
    expect(classifyRequest(gql("Viewer", {}))).toEqual({ operation: "viewer" });
    expect(classifyRequest(gql("BookmarkFoldersSlice", {}))).toEqual({ operation: "folders" });
  });

  test("ignores every other host, path, and operation", () => {
    expect(classifyRequest("https://evil.example/i/api/graphql/Q/Bookmarks")).toBeNull();
    expect(classifyRequest("http://x.com/i/api/graphql/Q/Bookmarks")).toBeNull();
    expect(classifyRequest("https://x.com/i/api/graphql/Q/CreateBookmark")).toBeNull();
    expect(classifyRequest("https://x.com/i/api/graphql/Q/HomeTimeline")).toBeNull();
    expect(classifyRequest("https://x.com/i/api/1.1/account/settings.json")).toBeNull();
    expect(classifyRequest("not a url")).toBeNull();
  });

  test("refuses malformed or oversized request variables instead of guessing", () => {
    expect(classifyRequest(gql("Bookmarks") + "?variables=%7Bnot-json")).toBeNull();
    expect(classifyRequest(gql("Bookmarks", { cursor: 5 }))).toBeNull();
    expect(classifyRequest(gql("Bookmarks", { cursor: "x".repeat(5000) }))).toBeNull();
    expect(
      classifyRequest(gql("BookmarkFolderTimeline", { bookmark_collection_id: "../1" })),
    ).toBeNull();
  });
});

describe("collection keys", () => {
  test("round-trip", () => {
    for (const ref of [
      { kind: "bookmarks" },
      { kind: "likes" },
      { kind: "bookmark_folder", folderId: "1800000000000000001" },
    ] as const) {
      expect(parseCollectionKey(collectionKey(ref))).toEqual(ref);
    }
    expect(parseCollectionKey("bookmark_folder:abc")).toBeNull();
  });
});

describe("mapping a parsed page to capture records", () => {
  const ok = (body: unknown): ParsedPage => {
    const r = xAdapter.parsePage(body, { kind: "bookmarks" });
    if (r.status !== "ok") throw new Error(r.status);
    return r.page;
  };

  test("keeps IDs as strings, author text, and a canonical link", () => {
    const mapped = toCaptureRecords(ok(fixture("bookmarks-page1.json")));
    expect(mapped.records[0]).toEqual({
      sourceType: "x_post",
      platformId: "1900000000000000101",
      text: "Synthetic long-form post body that is longer than the short legacy text.",
      authorId: "7000000000000000001",
      authorHandle: "synth_alice",
      canonicalUrl: "https://x.com/synth_alice/status/1900000000000000101",
      publishedAt: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
    });
    expect(mapped.cursorOut).toBe("SYNTHETIC_BOTTOM_CURSOR_1");
  });

  test("counts unavailable entries and gap-flagged threads", () => {
    const page = ok(fixture("bookmarks-page1.json"));
    const mapped = toCaptureRecords(page);
    expect(mapped.gaps.unavailable).toBe(page.unavailable.length);
    expect(mapped.gaps.partialThreads).toBe(
      page.threads.filter((t) => t.flags.length > 0 || t.unavailableEntryIds.length > 0).length,
    );
    expect(mapped.gaps.unavailable + mapped.gaps.partialThreads).toBeGreaterThan(0);
  });

  test("an exhausted page carries no continuation", () => {
    const mapped = toCaptureRecords(ok(fixture("bookmarks-last-page.json")));
    expect(mapped.cursorOut).toBeNull();
  });
});
