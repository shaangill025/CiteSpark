import {
  ADAPTER_VERSION,
  type CapturedPost,
  type CollectionRef,
  type ParsedPage,
  type ParseResult,
  type PostAuthor,
  type QuotedPost,
  type ThreadObservation,
  type Translation,
  type UnavailableEntry,
} from "./types.ts";

type Obj = Record<string, unknown>;

class SchemaError extends Error {}

class ControlOnlyError extends Error {}

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function dig(v: unknown, ...path: string[]): unknown {
  let cur = v;
  for (const key of path) {
    if (!isObj(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function reqString(v: unknown, what: string): string {
  if (typeof v !== "string" || v === "") throw new SchemaError(`missing ${what}`);
  return v;
}

function optString(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function timelineRoot(body: unknown, collection: CollectionRef): unknown {
  switch (collection.kind) {
    case "bookmarks":
      return dig(body, "data", "bookmark_timeline_v2", "timeline");
    case "bookmark_folder":
      return dig(body, "data", "bookmark_collection_timeline", "timeline");
    case "likes":
      return dig(body, "data", "user", "result", "timeline_v2", "timeline");
  }
}

type Unwrapped = { tweet: Obj } | { tombstone: true };

function unwrap(result: unknown): Unwrapped {
  if (!isObj(result)) throw new SchemaError("tweet result is not an object");
  switch (result["__typename"]) {
    case "Tweet":
      return { tweet: result };
    case "TweetWithVisibilityResults": {
      const inner = result["tweet"];
      if (!isObj(inner)) throw new SchemaError("visibility wrapper without tweet");
      return { tweet: inner };
    }
    case "TweetTombstone":
    case "TweetUnavailable":
      return { tombstone: true };
    default:
      throw new SchemaError(`unknown tweet result type`);
  }
}

function parseAuthor(tweet: Obj): PostAuthor {
  const user = dig(tweet, "core", "user_results", "result");
  return {
    id: reqString(dig(user, "rest_id"), "author id"),
    handle: reqString(dig(user, "legacy", "screen_name"), "author handle"),
  };
}

function parseDate(v: unknown): string {
  const raw = reqString(v, "created_at");
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new SchemaError("unparseable created_at");
  return new Date(ms).toISOString();
}

function parseTranslation(tweet: Obj): Translation | null {
  const t = tweet["translation"];
  if (t === undefined) return null;
  return {
    text: reqString(dig(t, "text"), "translation text"),
    sourceLanguage: optString(dig(t, "source_lang")),
    targetLanguage: optString(dig(t, "target_lang")),
    origin: "x-translation",
  };
}

function parseQuoted(tweet: Obj): QuotedPost | null {
  const legacyId = optString(dig(tweet, "legacy", "quoted_status_id_str"));
  const container = tweet["quoted_status_result"];
  if (container === undefined) {
    if (legacyId === null) return null;
    return {
      id: legacyId,
      unavailable: true,
      author: null,
      text: null,
      language: null,
      createdAt: null,
    };
  }
  const un = unwrap(dig(container, "result"));
  if ("tombstone" in un) {
    if (legacyId === null) throw new SchemaError("quoted tombstone without id");
    return {
      id: legacyId,
      unavailable: true,
      author: null,
      text: null,
      language: null,
      createdAt: null,
    };
  }
  return {
    id: reqString(un.tweet["rest_id"], "quoted id"),
    unavailable: false,
    author: parseAuthor(un.tweet),
    text: postText(un.tweet),
    language: optString(dig(un.tweet, "legacy", "lang")),
    createdAt: parseDate(dig(un.tweet, "legacy", "created_at")),
  };
}

function postText(tweet: Obj): string {
  const long = dig(tweet, "note_tweet", "note_tweet_results", "result", "text");
  if (typeof long === "string" && long !== "") return long;
  return reqString(dig(tweet, "legacy", "full_text"), "text");
}

function parseTweet(tweet: Obj): CapturedPost {
  const legacy = dig(tweet, "legacy");
  return {
    id: reqString(tweet["rest_id"], "rest_id"),
    role: "root",
    author: parseAuthor(tweet),
    text: postText(tweet),
    language: optString(dig(legacy, "lang")),
    createdAt: parseDate(dig(legacy, "created_at")),
    conversationId: optString(dig(legacy, "conversation_id_str")),
    inReplyToId: optString(dig(legacy, "in_reply_to_status_id_str")),
    quoted: parseQuoted(tweet),
    translation: parseTranslation(tweet),
    thread: null,
  };
}

interface ModuleItem {
  post: CapturedPost;
  replyToUserId: string | null;
}

function parseItem(
  item: unknown,
  entryId: string,
  unavailable: UnavailableEntry[],
): ModuleItem | null {
  if (dig(item, "itemType") !== "TimelineTweet") throw new SchemaError("unknown item type");
  const un = unwrap(dig(item, "tweet_results", "result"));
  if ("tombstone" in un) {
    unavailable.push({ entryId, reason: "tombstone" });
    return null;
  }
  return {
    post: parseTweet(un.tweet),
    replyToUserId: optString(dig(un.tweet, "legacy", "in_reply_to_user_id_str")),
  };
}

/**
 * Same-author replies join a thread only with explicit reply-chain evidence (CAP-08).
 * `rootUnavailable` means X delivered the opening post as a tombstone: the first surviving post
 * is then not a root, its author cannot be compared with the real root author, and every
 * surviving member is uncertain.
 */
function resolveThread(
  items: ModuleItem[],
  unavailableEntryIds: string[],
  rootUnavailable: boolean,
): { posts: CapturedPost[]; thread: ThreadObservation } {
  const first = items[0];
  if (!first) throw new SchemaError("empty module");
  const root = first.post;
  const rootId = rootUnavailable ? (root.conversationId ?? root.inReplyToId ?? root.id) : root.id;
  const ids = new Set(items.map((i) => i.post.id));
  const confirmed = new Set<string>(rootUnavailable ? [] : [root.id]);
  for (let changed = true; changed;) {
    changed = false;
    for (const { post, replyToUserId } of items) {
      if (
        !confirmed.has(post.id) &&
        post.author.id === root.author.id &&
        post.inReplyToId !== null &&
        confirmed.has(post.inReplyToId) &&
        replyToUserId === root.author.id
      ) {
        confirmed.add(post.id);
        changed = true;
      }
    }
  }
  const flags: string[] = rootUnavailable ? ["root_unavailable"] : [];
  const excludedReplyIds: string[] = [];
  const posts: CapturedPost[] = [];
  let sequence = 0;
  for (const { post } of items) {
    if (post.author.id !== root.author.id) {
      excludedReplyIds.push(post.id);
      continue;
    }
    if (confirmed.has(post.id)) {
      posts.push({
        ...post,
        role: post.id === rootId ? "root" : "thread_continuation",
        thread: { rootId, sequence: sequence++, membership: "confirmed" },
      });
      continue;
    }
    if (post.inReplyToId !== null && !ids.has(post.inReplyToId)) {
      flags.push(`missing_parent:${post.inReplyToId}`);
    }
    flags.push(`uncertain_membership:${post.id}`);
    posts.push({
      ...post,
      role: "thread_continuation",
      thread: { rootId, sequence: null, membership: "uncertain" },
    });
  }
  return {
    posts,
    thread: {
      rootId,
      postIds: posts.map((p) => p.id),
      excludedReplyIds,
      unavailableEntryIds,
      flags,
    },
  };
}

function parseEntries(entries: unknown[]) {
  const posts: CapturedPost[] = [];
  const threads: ThreadObservation[] = [];
  const unavailable: UnavailableEntry[] = [];
  let cursorOut: string | null = null;
  for (const entry of entries) {
    const entryId = reqString(dig(entry, "entryId"), "entryId");
    const content = dig(entry, "content");
    switch (dig(content, "entryType")) {
      case "TimelineTimelineCursor": {
        const type = dig(content, "cursorType");
        if (type === "Bottom") cursorOut = reqString(dig(content, "value"), "cursor value");
        else if (type !== "Top") throw new SchemaError("unknown cursor type");
        break;
      }
      case "TimelineTimelineItem": {
        const parsed = parseItem(dig(content, "itemContent"), entryId, unavailable);
        if (parsed) posts.push(parsed.post);
        break;
      }
      case "TimelineTimelineModule": {
        const rawItems = dig(content, "items");
        if (!Array.isArray(rawItems)) throw new SchemaError("module without items");
        const items: ModuleItem[] = [];
        const moduleUnavailable: UnavailableEntry[] = [];
        for (const raw of rawItems) {
          const id = reqString(dig(raw, "entryId"), "module item entryId");
          const parsed = parseItem(dig(raw, "item", "itemContent"), id, moduleUnavailable);
          if (parsed) items.push(parsed);
        }
        unavailable.push(...moduleUnavailable);
        if (items.length === 0) break;
        const rootUnavailable = isLeadingTombstone(rawItems, moduleUnavailable);
        const resolved = resolveThread(
          items,
          moduleUnavailable.map((u) => u.entryId),
          rootUnavailable,
        );
        posts.push(...resolved.posts);
        // Keep the observation whenever it carries a gap, even for a single surviving item.
        if (items.length > 1 || resolved.thread.flags.length > 0 || moduleUnavailable.length > 0) {
          threads.push(resolved.thread);
        }
        break;
      }
      default:
        throw new SchemaError("unknown entry type");
    }
  }
  return { posts, threads, unavailable, cursorOut };
}

function isLeadingTombstone(rawItems: unknown[], moduleUnavailable: UnavailableEntry[]): boolean {
  const firstId = dig(rawItems[0], "entryId");
  return moduleUnavailable.some((u) => u.entryId === firstId);
}

export function parsePage(body: unknown, collection: CollectionRef): ParseResult {
  try {
    const timeline = timelineRoot(body, collection);
    const instructions = dig(timeline, "instructions");
    if (!Array.isArray(instructions)) throw new SchemaError("timeline instructions not found");
    const entries: unknown[] = [];
    let sawEntries = false;
    let terminatedBottom = false;
    for (const ins of instructions) {
      const type = dig(ins, "type");
      if (type === "TimelineAddEntries") {
        const list = dig(ins, "entries");
        if (!Array.isArray(list)) throw new SchemaError("entries not an array");
        sawEntries = true;
        entries.push(...list);
      } else if (type === "TimelineTerminateTimeline") {
        const direction = dig(ins, "direction");
        if (direction === "Bottom" || direction === "TopAndBottom") terminatedBottom = true;
        else if (direction !== "Top") throw new SchemaError("unknown termination direction");
      } else if (type !== "TimelineClearCache") {
        throw new SchemaError("unknown instruction type");
      }
    }
    // Cache control alone says nothing about where the collection ends (CAP-06).
    if (!sawEntries && !terminatedBottom)
      throw new ControlOnlyError("no page entries or termination");
    const parsed = parseEntries(entries);
    const page: ParsedPage = {
      adapterVersion: ADAPTER_VERSION,
      collection,
      ...parsed,
      // A bottom cursor without bottom termination is a continuation, even on a page with no
      // content entries (CAP-06): zero entries is no evidence that the collection ended.
      exhausted: terminatedBottom || parsed.cursorOut === null,
    };
    return { status: "ok", page };
  } catch (err) {
    if (err instanceof ControlOnlyError) {
      return {
        status: "paused",
        reason: "control_only",
        detail: err.message,
        adapterVersion: ADAPTER_VERSION,
      };
    }
    if (err instanceof SchemaError) {
      return {
        status: "paused",
        reason: "unsupported_schema",
        detail: err.message,
        adapterVersion: ADAPTER_VERSION,
      };
    }
    throw err;
  }
}
