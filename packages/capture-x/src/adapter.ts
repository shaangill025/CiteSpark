import { dig, parsePage } from "./parse.ts";
import {
  ADAPTER_ID,
  ADAPTER_VERSION,
  type AccountIdentity,
  type CaptureAdapter,
  type CollectionInfo,
  type NextStep,
  type ParsedPage,
} from "./types.ts";

function detectAccount(body: unknown): AccountIdentity | null {
  const user = dig(body, "data", "viewer", "user_results", "result");
  const accountId = dig(user, "rest_id");
  const handle = dig(user, "legacy", "screen_name");
  if (typeof accountId !== "string" || typeof handle !== "string") return null;
  return { accountId, handle };
}

function listCollections(body: unknown): CollectionInfo[] {
  const list: CollectionInfo[] = [{ kind: "bookmarks" }, { kind: "likes" }];
  const items = dig(
    body,
    "data",
    "viewer",
    "user_results",
    "result",
    "bookmark_collections_slice",
    "items",
  );
  if (Array.isArray(items)) {
    for (const item of items) {
      const folderId = dig(item, "id");
      const name = dig(item, "name");
      if (typeof folderId === "string" && typeof name === "string") {
        list.push({ kind: "bookmark_folder", folderId, name });
      }
    }
  }
  return list;
}

function nextRequest(page: ParsedPage): NextStep {
  if (page.exhausted || page.cursorOut === null) return { kind: "end" };
  return { kind: "scroll", expectCursor: page.cursorOut };
}

export const xAdapter: CaptureAdapter = {
  id: ADAPTER_ID,
  version: ADAPTER_VERSION,
  detectAccount,
  listCollections,
  parsePage,
  nextRequest,
};
