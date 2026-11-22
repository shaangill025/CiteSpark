import { describe, expect, test } from "vitest";
import { installObserver, type ObserverWindow } from "../src/observer/observe.ts";
import type { Observation } from "../src/background/run.ts";
import { bookmarksUrl } from "./mock-x/bodies.ts";

function fakeWindow(respond: (input: unknown, init: unknown) => Promise<Response>) {
  const calls: { input: unknown; init: unknown }[] = [];
  const win: ObserverWindow = {
    location: { href: "https://x.com/i/bookmarks" },
    fetch: ((input: unknown, init: unknown) => {
      calls.push({ input, init });
      return respond(input, init);
    }) as typeof fetch,
  };
  const seen: Observation[] = [];
  installObserver(win, (o) => seen.push(o), { maxBodyBytes: 64 });
  return { win, calls, seen };
}

const settle = () => new Promise((r) => setTimeout(r, 10));

describe("page-context observer (ADR 0005, SEC-04)", () => {
  test("reports X's own collection response and leaves the response to X untouched", async () => {
    const f = fakeWindow(async () => new Response('{"data":1}', { status: 200 }));
    const init = { headers: { authorization: "Bearer SYNTHETIC-CANARY" } };
    const res = await f.win.fetch(bookmarksUrl("C1"), init);
    expect(await res.text()).toBe('{"data":1}');
    expect(f.calls[0]!.init).toBe(init); // passed through as the same object, never rewritten
    await settle();
    expect(f.seen).toEqual([
      {
        kind: "page",
        collection: "bookmarks",
        cursor: "C1",
        status: 200,
        retryAfter: null,
        body: '{"data":1}',
        tooLarge: false,
      },
    ]);
    expect(JSON.stringify(f.seen)).not.toContain("SYNTHETIC-CANARY");
  });

  test("ignores every unrecognized request", async () => {
    const f = fakeWindow(async () => new Response("{}"));
    await f.win.fetch("https://x.com/i/api/graphql/Q/HomeTimeline");
    await f.win.fetch(
      new Request("https://x.com/i/api/graphql/Q/CreateBookmark", { method: "POST" }),
    );
    await settle();
    expect(f.seen).toEqual([]);
  });

  test("recognizes Request objects and relative URLs", async () => {
    const f = fakeWindow(async () => new Response("{}"));
    await f.win.fetch(new Request(bookmarksUrl(null)));
    await f.win.fetch("/i/api/graphql/Q/Viewer");
    await f.win.fetch("/i/api/graphql/Q/BookmarkFoldersSlice");
    await settle();
    expect(f.seen.map((o) => o.kind)).toEqual(["page", "viewer", "folders"]);
  });

  test("bounds untrusted bodies with and without a declared length", async () => {
    const big = "x".repeat(100);
    const declared = fakeWindow(
      async () => new Response(big, { headers: { "content-length": "100" } }),
    );
    await declared.win.fetch(bookmarksUrl(null));
    const streamed = fakeWindow(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (let i = 0; i < 10; i++) c.enqueue(new TextEncoder().encode("y".repeat(10)));
              c.close();
            },
          }),
        ),
    );
    const res = await streamed.win.fetch(bookmarksUrl(null));
    expect((await res.text()).length).toBe(100);
    await settle();
    expect(declared.seen[0]).toMatchObject({ tooLarge: true, body: null });
    expect(streamed.seen[0]).toMatchObject({ tooLarge: true, body: null });
  });

  test("reports 429 with Retry-After and network failures without changing them", async () => {
    const limited = fakeWindow(
      async () => new Response("", { status: 429, headers: { "retry-after": "7" } }),
    );
    expect((await limited.win.fetch(bookmarksUrl(null))).status).toBe(429);
    const failing = fakeWindow(async () => {
      throw new TypeError("network down");
    });
    await expect(failing.win.fetch(bookmarksUrl(null))).rejects.toThrow("network down");
    await settle();
    expect(limited.seen[0]).toMatchObject({ status: 429, retryAfter: "7", body: null });
    expect(failing.seen[0]).toMatchObject({ status: 0, body: null });
  });
});
