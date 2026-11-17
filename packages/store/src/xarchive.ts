import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { extname } from "node:path";
import type Database from "better-sqlite3";
import {
  isWeakerText,
  retainedVersion,
  type AvailabilityReport,
  type CapturePage,
  type CaptureRecord,
  type CaptureStore,
  type CommitOptions,
} from "./capture.ts";
import type { JobStore } from "./jobs.ts";

/**
 * Importer for `sytelus/xarchive` JSON exports (MIG-01, Q38). The format is read, never executed;
 * the source is treated as untrusted data (SEC-06).
 */
export const XARCHIVE_PIN = {
  repository: "https://github.com/sytelus/xarchive",
  commit: "ae9d0263617a200ce142e64fb2ddc6301ebf19cf",
  version: "1.1.0",
  /** `export_metadata.schema_version` values this importer understands. `null` means a legacy file. */
  schemaVersions: [1, 2],
} as const;

export const IMPORT_ADAPTER_ID = "xarchive-import";
export const IMPORT_COLLECTION_ID = "x:bookmarks";
const PAGE_SIZE = 100;

export interface ImportLimits {
  maxBytes: number;
  maxBookmarks: number;
  maxTextLength: number;
  maxDepth: number;
}

export const DEFAULT_IMPORT_LIMITS: ImportLimits = {
  maxBytes: 128 * 1024 * 1024,
  maxBookmarks: 500_000,
  maxTextLength: 200_000,
  maxDepth: 64,
};

/** The file is not an xarchive export this importer supports, or it is malformed. Nothing is written. */
export class XArchiveFormatError extends Error {}
/** The path or file is not an acceptable import source. */
export class UnsafeImportPathError extends Error {}
/** The file exceeds a configured size or complexity limit. */
export class ImportLimitError extends Error {}
/** Commit was refused because the preview reported blockers. */
export class ImportBlockedError extends Error {}

export type WarningCode =
  | "legacy-schema"
  | "no-collection-coverage"
  | "unavailable-no-text"
  | "available-no-text"
  | "invalid-date"
  | "invalid-handle"
  | "invalid-author-id"
  | "duplicate-in-file"
  | "duplicate-distinct-versions"
  | "conflicting-availability"
  | "folders-not-imported"
  | "unknown-provenance"
  | "trashed-or-purged";

export interface ImportWarning {
  code: WarningCode;
  message: string;
  count: number;
}

interface Bookmark {
  platformId: string;
  /**
   * Availability of the report that carried this text. When several in-file reports carried the
   * same text with different statuses, `available` is listed here and the rest in `alsoReported`;
   * that choice is canonical, not chronological.
   */
  status: "available" | "unavailable";
  /**
   * Other in-file reports of this ID that deduplication folded into this text: same text with
   * another status, or a weaker (truncated or empty) text. At most one per availability, sorted.
   * Absent when there are none.
   */
  alsoReported?: AvailabilityReport[];
  text: string;
  authorId: string | null;
  authorHandle: string | null;
  publishedAt: string | null;
}

export interface ParsedExport {
  schemaVersion: number | null;
  exporterVersion: string | null;
  /** Canonical account ID, or `null` when the file carries no usable account (`unknown` stays unknown). */
  accountId: string | null;
  exportedAt: string | null;
  contentHash: string;
  bookmarks: Bookmark[];
  folderCount: number;
  warnings: ImportWarning[];
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const ID = /^\d{1,25}$/;
const HANDLE = /^[A-Za-z0-9_]{1,15}$/;
const sha256 = (s: string): string => createHash("sha256").update(s, "utf8").digest("hex");

/** Open flags: never follow a final symlink, never block on a FIFO. Unsupported flags are 0. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

/**
 * Read an export file with bounded memory. Only regular `.json` files are accepted: symlinks,
 * FIFOs, devices, directories, and NUL-bearing or non-JSON paths are refused before the file is
 * opened, and the opened descriptor must be the same regular file (SEC-06). Archives (for example
 * ZIP) are never expanded: xarchive exports are single JSON files. Invalid UTF-8 is rejected rather
 * than replaced.
 */
export function readXArchiveFile(
  path: string,
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
): string {
  if (typeof path !== "string" || path.length === 0 || path.includes("\0")) {
    throw new UnsafeImportPathError("import path is empty or contains a NUL byte");
  }
  if (extname(path).toLowerCase() !== ".json") {
    throw new UnsafeImportPathError("an xarchive export is a .json file");
  }
  const pre = lstatSync(path);
  if (pre.isSymbolicLink()) throw new UnsafeImportPathError("symbolic links are not followed");
  if (!pre.isFile()) throw new UnsafeImportPathError("import source is not a regular file");
  if (pre.size > limits.maxBytes) {
    throw new ImportLimitError(`file is ${pre.size} bytes; the limit is ${limits.maxBytes}`);
  }
  let fd: number;
  try {
    fd = openSync(path, OPEN_FLAGS);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ELOOP") {
      throw new UnsafeImportPathError("symbolic links are not followed");
    }
    throw e;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.dev !== pre.dev || st.ino !== pre.ino) {
      throw new UnsafeImportPathError("import source changed or is not a regular file");
    }
    if (st.size > limits.maxBytes) {
      throw new ImportLimitError(`file is ${st.size} bytes; the limit is ${limits.maxBytes}`);
    }
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n === 0) break;
      off += n;
    }
    try {
      return UTF8.decode(buf.subarray(0, off));
    } catch {
      throw new XArchiveFormatError("export is not valid UTF-8");
    }
  } finally {
    closeSync(fd);
  }
}

/** Maximum bracket nesting, counted outside strings, so a hostile file cannot exhaust the parser stack. */
function nestingDepth(json: string): number {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    if (inString) {
      if (c === 0x5c) i++;
      else if (c === 0x22) inString = false;
    } else if (c === 0x22) inString = true;
    else if (c === 0x5b || c === 0x7b) {
      if (++depth > max) max = depth;
    } else if (c === 0x5d || c === 0x7d) depth--;
  }
  return max;
}

const toIso = (v: unknown): string | null => {
  if (typeof v !== "string" || v.length === 0) return null;
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
};

/**
 * Validate and map an export. Structural problems, unsupported schemas, and limit violations throw
 * before anything is returned; tolerable gaps become warnings (MIG-01: reject rather than guess).
 */
export function parseXArchive(
  json: string,
  limits: ImportLimits = DEFAULT_IMPORT_LIMITS,
): ParsedExport {
  if (typeof json !== "string") throw new XArchiveFormatError("export must be text");
  if (Buffer.byteLength(json, "utf8") > limits.maxBytes) {
    throw new ImportLimitError(`file exceeds ${limits.maxBytes} bytes`);
  }
  if (nestingDepth(json) > limits.maxDepth) {
    throw new ImportLimitError(`nesting deeper than ${limits.maxDepth}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(json);
  } catch {
    throw new XArchiveFormatError("not valid JSON");
  }
  if (!isObject(data) || !Array.isArray(data.bookmarks)) {
    throw new XArchiveFormatError("expected an object with a bookmarks array");
  }
  if (data.bookmarks.length > limits.maxBookmarks) {
    throw new ImportLimitError(`${data.bookmarks.length} bookmarks exceeds ${limits.maxBookmarks}`);
  }
  const meta = data.export_metadata ?? {};
  if (!isObject(meta)) throw new XArchiveFormatError("invalid export_metadata");
  if (meta.tool !== undefined && meta.tool !== "xarchive") {
    throw new XArchiveFormatError("export_metadata.tool is not xarchive");
  }
  let schemaVersion: number | null = null;
  if (meta.schema_version !== undefined && meta.schema_version !== null) {
    const v = meta.schema_version;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      throw new XArchiveFormatError("invalid schema_version");
    }
    if (!(XARCHIVE_PIN.schemaVersions as readonly number[]).includes(v)) {
      throw new XArchiveFormatError(
        `unsupported schema_version ${v}; this importer supports ${XARCHIVE_PIN.schemaVersions.join(", ")}`,
      );
    }
    schemaVersion = v;
  }
  for (const k of ["user_id", "screen_name", "kind", "version"]) {
    if (meta[k] != null && typeof meta[k] !== "string") {
      throw new XArchiveFormatError(`invalid export_metadata.${k}`);
    }
  }
  if (data.folders != null && !Array.isArray(data.folders)) {
    throw new XArchiveFormatError("invalid folders");
  }
  for (const f of (data.folders as unknown[] | undefined) ?? []) {
    if (!isObject(f) || typeof f.id !== "string" || typeof f.name !== "string") {
      throw new XArchiveFormatError("each folder needs a string id and name");
    }
  }

  const counts: Record<string, number> = {};
  const bump = (code: WarningCode): void => void (counts[code] = (counts[code] ?? 0) + 1);

  // Records per tweet_id, in file order of first appearance. A duplicate whose text is identical
  // to, or weaker than (by content, see `isWeakerText`), a kept record is dropped; kept records it
  // dominates are replaced. Distinct texts are all kept and become versions of one source.
  const byId = new Map<string, Bookmark[]>();
  // Every report per tweet_id, for availability evidence, which is independent of text quality.
  const reportsById = new Map<string, { text: string; status: Bookmark["status"] }[]>();
  data.bookmarks.forEach((b: unknown, i) => {
    const bad = (what: string): never => {
      throw new XArchiveFormatError(`bookmark ${i}: ${what}`);
    };
    if (!isObject(b)) return bad("not an object");
    if (typeof b.tweet_id !== "string" || !ID.test(b.tweet_id)) return bad("invalid tweet_id");
    for (const k of ["full_text", "created_at"]) {
      if (b[k] != null && typeof b[k] !== "string") bad(`invalid ${k}`);
    }
    if (b.author != null && !isObject(b.author)) bad("invalid author");
    const author = (b.author ?? {}) as Record<string, unknown>;
    for (const k of ["user_id", "screen_name"]) {
      if (author[k] != null && typeof author[k] !== "string") bad(`invalid author.${k}`);
    }
    for (const k of ["folders", "folder_ids"]) {
      const v = b[k];
      if (v != null && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) {
        bad(`invalid ${k}`);
      }
    }
    if (b.status !== undefined && b.status !== "available" && b.status !== "unavailable") {
      bad("invalid status");
    }
    const text = typeof b.full_text === "string" ? b.full_text : "";
    if (text.length > limits.maxTextLength) {
      throw new ImportLimitError(`bookmark ${i}: text exceeds ${limits.maxTextLength} characters`);
    }

    let authorId: string | null = null;
    if (typeof author.user_id === "string") {
      if (ID.test(author.user_id)) authorId = `x:user:${author.user_id}`;
      else bump("invalid-author-id");
    }
    let authorHandle: string | null = null;
    if (typeof author.screen_name === "string") {
      if (HANDLE.test(author.screen_name)) authorHandle = author.screen_name;
      else bump("invalid-handle");
    }
    const publishedAt = toIso(b.created_at);
    if (b.created_at != null && publishedAt === null) bump("invalid-date");

    const next: Bookmark = {
      platformId: b.tweet_id,
      status: b.status === "unavailable" ? "unavailable" : "available",
      text,
      authorId,
      authorHandle,
      publishedAt,
    };
    const seen = reportsById.get(next.platformId);
    if (seen) seen.push({ text, status: next.status });
    else reportsById.set(next.platformId, [{ text, status: next.status }]);
    const kept = byId.get(next.platformId);
    if (!kept) {
      byId.set(next.platformId, [next]);
      return;
    }
    bump("duplicate-in-file");
    const texts = kept.map((k) => k.text);
    if (texts.includes(next.text) || isWeakerText(next.text, texts)) return;
    byId.set(next.platformId, [...kept.filter((k) => !isWeakerText(k.text, [next.text])), next]);
  });
  const distinctVersions = [...byId.values()].filter((k) => k.length > 1).length;

  // Attach each report to the kept text it belongs to: its own text, or else the kept version
  // that makes it weaker (chosen by content). Per kept text, one report per availability, keeping
  // the one that carried the most text. The result does not depend on file order.
  const RANK = { empty: 0, truncated: 1, same: 2 } as const;
  let conflicting = 0;
  for (const [id, kept] of byId) {
    const keptTexts = kept.map((k) => k.text);
    const perKept = kept.map(() => new Map<Bookmark["status"], AvailabilityReport["text"]>());
    for (const d of reportsById.get(id)!) {
      let at = keptTexts.indexOf(d.text);
      let kind: AvailabilityReport["text"] = "same";
      if (at < 0) {
        const r = retainedVersion(d.text, keptTexts);
        if (r === null) throw new Error(`internal: dropped report of ${id} has no retained text`);
        at = r;
        kind = d.text === "" ? "empty" : "truncated";
      }
      const m = perKept[at]!;
      const prior = m.get(d.status);
      if (prior === undefined || RANK[kind] > RANK[prior]) m.set(d.status, kind);
    }
    kept.forEach((k, i) => {
      const reports = (["available", "unavailable"] as const)
        .filter((a) => perKept[i]!.has(a))
        .map((availability) => ({ availability, text: perKept[i]!.get(availability)! }));
      const own = reports.find((r) => r.text === "same")!;
      k.status = own.availability;
      const also = reports.filter((r) => r !== own);
      if (also.length > 0) k.alsoReported = also;
      else delete k.alsoReported;
      if (reports.length > 1) conflicting++;
    });
  }

  const userId = typeof meta.user_id === "string" && ID.test(meta.user_id) ? meta.user_id : null;
  const warnings: ImportWarning[] = [];
  const warn = (code: WarningCode, message: string, count = 1): void => {
    if (count > 0) warnings.push({ code, message, count });
  };
  if (schemaVersion === null) warn("legacy-schema", "legacy export without schema_version");
  const coverage = isObject(meta.collection) ? meta.collection : null;
  if (!coverage || coverage.bookmarks === "unknown" || coverage.bookmarks === undefined) {
    warn("no-collection-coverage", "collection completeness is unknown; no coverage is claimed");
  }
  warn(
    "invalid-date",
    "unparseable created_at; published date left unknown",
    counts["invalid-date"] ?? 0,
  );
  warn(
    "invalid-handle",
    "author handle failed validation and was dropped",
    counts["invalid-handle"] ?? 0,
  );
  warn(
    "invalid-author-id",
    "author id was not numeric and was dropped",
    counts["invalid-author-id"] ?? 0,
  );
  warn(
    "duplicate-in-file",
    "tweet_id repeated in file; identical or truncated repeats dropped in favor of the fuller text; their availability is kept as evidence",
    counts["duplicate-in-file"] ?? 0,
  );
  warn(
    "conflicting-availability",
    "tweet_id reported both available and unavailable in file; both reports are kept on one observation marked conflicting, and file order is not treated as time",
    conflicting,
  );
  warn(
    "duplicate-distinct-versions",
    "tweet_id repeated in file with distinct texts; each is kept as a separate version of the post",
    distinctVersions,
  );
  const folderCount = Array.isArray(data.folders) ? data.folders.length : 0;
  if (
    folderCount > 0 ||
    data.bookmarks.some((b) => isObject(b) && (b.folder_ids as unknown[])?.length)
  ) {
    warn("folders-not-imported", "folder assignments are reported but not stored by this layer");
  }
  warn(
    "unknown-provenance",
    "bookmark time is unknown: xarchive records observation, not bookmarking",
  );

  return {
    schemaVersion,
    exporterVersion: typeof meta.version === "string" ? meta.version : null,
    accountId: userId ? `x:account:${userId}` : null,
    exportedAt: toIso(meta.exported_at),
    contentHash: sha256(json),
    bookmarks: [...byId.values()].flat(),
    folderCount,
    warnings,
  };
}

/** Field mapping shown to the user in the preview. */
export const XARCHIVE_MAPPING: readonly { from: string; to: string }[] = [
  { from: "export_metadata.user_id", to: "account x:account:<id>; collection x:bookmarks" },
  { from: "bookmarks[].tweet_id", to: "source x_post:<id> (string, never a number)" },
  { from: "bookmarks[].full_text", to: "source_version.text (observation method: import)" },
  { from: "bookmarks[].author.user_id", to: "source.author_id x:user:<id>" },
  { from: "bookmarks[].author.screen_name", to: "source.author_handle; canonical URL" },
  { from: "bookmarks[].created_at", to: "source_version.published_at (ISO 8601 or unknown)" },
  { from: "folders, bookmarks[].folder_ids", to: "reported only; not stored" },
];

export interface ImportConflict {
  platformId: string;
  kind: "weaker-skipped" | "new-version";
}

export interface ImportPreview {
  /** Always false: previewing never writes. */
  writes: false;
  accountId: string | null;
  schemaVersion: number | null;
  mapping: typeof XARCHIVE_MAPPING;
  counts: {
    inFile: number;
    new: number;
    /** Same text already stored; re-observed only. */
    duplicates: number;
    /** Differing text from a stored version, kept alongside it as a new version. */
    newVersions: number;
    /** Incoming content is weaker than a stored version: no version is added; membership is kept. */
    weakerSkipped: number;
    /**
     * Reported unavailable with no text and no stored text: identity, membership, and an
     * unavailable observation of an empty snapshot are recorded; no text is captured.
     */
    unavailableNoText: number;
    /** Reported available but with no text and no stored copy: nothing to store. */
    noContentSkipped: number;
    /** The stored source is trashed or purged: not re-imported until restored (DAT-03, Q50). */
    suppressed: number;
    /** Records expected to add or re-observe content (new + duplicates + newVersions). */
    toCommit: number;
  };
  conflicts: ImportConflict[];
  warnings: ImportWarning[];
  /** Reasons commit is refused. Empty means the preview can be committed. */
  blockers: string[];
  /** The same file was already imported to completion; commit would be a no-op. */
  alreadyImported: boolean;
  jobId: string | null;
  /**
   * The page plan commit sends through the shared capture commit path: every record in the file,
   * in file order. It depends only on the file, so an interrupted import resumes with the same
   * pages; whether a record is weaker than stored content is decided again inside each commit.
   */
  records: CaptureRecord[];
}

export const importJobId = (parsed: ParsedExport): string =>
  `import:xarchive:${parsed.accountId}:${parsed.contentHash}`;

const toRecord = (b: Bookmark): CaptureRecord => ({
  sourceType: "x_post",
  platformId: b.platformId,
  text: b.text,
  authorId: b.authorId,
  authorHandle: b.authorHandle,
  canonicalUrl: b.authorHandle ? `https://x.com/${b.authorHandle}/status/${b.platformId}` : null,
  publishedAt: b.publishedAt,
  availability: b.status,
  retainFuller: true,
  ...(b.alsoReported?.length ? { alsoReported: b.alsoReported } : {}),
});
const reportsUnavailable = (b: Bookmark): boolean =>
  b.status === "unavailable" ||
  (b.alsoReported ?? []).some((a) => a.availability === "unavailable");

/** Dry run: classifies every record against the store without writing (MIG-01). */
export function previewXArchive(db: Database.Database, parsed: ParsedExport): ImportPreview {
  const counts = {
    inFile: parsed.bookmarks.length,
    new: 0,
    duplicates: 0,
    newVersions: 0,
    weakerSkipped: 0,
    unavailableNoText: 0,
    noContentSkipped: 0,
    suppressed: 0,
    toCommit: 0,
  };
  const conflicts: ImportConflict[] = [];
  const stored = db.prepare(
    `SELECT sv.text FROM source s JOIN source_version sv ON sv.source_id = s.id
     WHERE s.source_type = 'x_post' AND s.platform_id = ?`,
  );
  const known = db.prepare("SELECT 1 FROM source WHERE source_type = 'x_post' AND platform_id = ?");
  // Mirrors the commit, which skips records of trashed or purged sources (DAT-03).
  const isSuppressed = db.prepare(
    `SELECT 1 FROM source WHERE source_type = 'x_post' AND platform_id = ?
       AND (trashed_at IS NOT NULL OR purged_at IS NOT NULL)`,
  );
  // Mirrors the commit, which sees earlier records of the same file as stored when it reaches a
  // later one (in-file repeats with distinct texts).
  const pending = new Map<string, string[]>();
  for (const b of parsed.bookmarks) {
    if (isSuppressed.get(b.platformId) !== undefined) {
      counts.suppressed++;
      continue;
    }
    const earlier = pending.get(b.platformId);
    const versions = [
      ...(stored.all(b.platformId) as { text: string }[]).map((r) => r.text),
      ...(earlier ?? []),
    ];
    const exists = earlier !== undefined || known.get(b.platformId) !== undefined;
    let adds = true;
    if (exists && isWeakerText(b.text, versions)) {
      counts.weakerSkipped++;
      conflicts.push({ platformId: b.platformId, kind: "weaker-skipped" });
      adds = false;
    } else if (b.text === "" && reportsUnavailable(b)) {
      counts.unavailableNoText++;
    } else if (b.text === "" && !exists) {
      counts.noContentSkipped++;
      adds = false;
    } else if (exists && versions.includes(b.text)) {
      counts.duplicates++;
    } else if (exists) {
      counts.newVersions++;
      conflicts.push({ platformId: b.platformId, kind: "new-version" });
    } else {
      counts.new++;
    }
    if (adds) pending.set(b.platformId, [...(earlier ?? []), b.text]);
  }
  counts.toCommit = counts.new + counts.duplicates + counts.newVersions;

  const warnings = [...parsed.warnings];
  if (counts.unavailableNoText > 0) {
    warnings.push({
      code: "unavailable-no-text",
      message:
        "unavailable bookmarks with no retained text and no stored copy: identity, membership and unavailability are recorded; no text is captured",
      count: counts.unavailableNoText,
    });
  }
  if (counts.suppressed > 0) {
    warnings.push({
      code: "trashed-or-purged",
      message: "bookmarks of trashed or purged sources: not re-imported; nothing is stored",
      count: counts.suppressed,
    });
  }
  if (counts.noContentSkipped > 0) {
    warnings.push({
      code: "available-no-text",
      message: "available bookmarks with no text and no stored copy: nothing is stored",
      count: counts.noContentSkipped,
    });
  }
  const blockers: string[] = [];
  if (parsed.accountId === null) {
    blockers.push("export has no usable user_id; an account-less file cannot be merged");
  }
  const jobId = parsed.accountId === null ? null : importJobId(parsed);
  const prior = jobId
    ? (db.prepare("SELECT state FROM job WHERE id = ?").get(jobId) as { state: string } | undefined)
    : undefined;
  if (prior?.state === "cancelled") {
    blockers.push("an import of this file was cancelled; committed records are kept");
  }
  return {
    writes: false,
    accountId: parsed.accountId,
    schemaVersion: parsed.schemaVersion,
    mapping: XARCHIVE_MAPPING,
    counts,
    conflicts,
    warnings,
    blockers,
    alreadyImported: prior?.state === "complete",
    jobId,
    records: parsed.bookmarks.map(toRecord),
  };
}

export interface ImportReceipt {
  /** `cancelled`: a user cancel was honored at a page boundary; committed pages are kept (CAP-04). */
  status: "imported" | "already-imported" | "cancelled";
  jobId: string;
  pages: number;
  newRecords: number;
  newSources: number;
  newVersions: number;
  /**
   * Records whose text was weaker than stored content at commit time: membership and availability
   * evidence against the retained version; no version added.
   */
  weakerSkipped: number;
  /** Unavailable records with no text and no stored text: identity, membership, evidence only. */
  unavailableNoText: number;
  /** Available records with no text and no stored copy at commit time: nothing written. */
  noContentSkipped: number;
  /** Records of a source trashed or purged at commit time: not re-imported, nothing written. */
  suppressed: number;
  preview: ImportPreview;
}

export interface CommitImportOptions {
  owner: string;
  /** Epoch-ms clock, read afresh before acquiring and before every page. Defaults to `Date.now`. */
  clock?: () => number;
  leaseTtlMs?: number;
  /** Passed to every page commit; test seam for crash injection (T01, T09). */
  commitOptions?: CommitOptions;
}

/**
 * Commit a previewed import through the shared capture commit path (CAP-03). One deterministic job
 * per file content makes a repeated import a no-op and lets an interrupted import resume.
 *
 * The lease token `JobStore.acquire` returns is retained for every page. Before each page the clock
 * is read again and the lease renewed, so an import that outlives its lease stops with
 * `LeaseError` instead of writing under a stale time. A cancel request is honored at the next page
 * boundary: the job becomes `cancelled` and pages already committed are kept (CAP-04).
 */
export function commitXArchive(
  db: Database.Database,
  jobs: JobStore,
  capture: CaptureStore,
  parsed: ParsedExport,
  options: CommitImportOptions,
): ImportReceipt {
  const clock = options.clock ?? Date.now;
  const ttl = options.leaseTtlMs ?? 60_000;
  const preview = previewXArchive(db, parsed);
  if (preview.blockers.length > 0 || preview.jobId === null || parsed.accountId === null) {
    throw new ImportBlockedError(preview.blockers.join("; "));
  }
  const jobId = preview.jobId;
  const totals = {
    pages: 0,
    newRecords: 0,
    newSources: 0,
    newVersions: 0,
    weakerSkipped: 0,
    unavailableNoText: 0,
    noContentSkipped: 0,
    suppressed: 0,
  };
  const receipt = (status: ImportReceipt["status"]): ImportReceipt => ({
    status,
    jobId,
    ...totals,
    preview,
  });
  const existing = db.prepare("SELECT state FROM job WHERE id = ?").get(jobId) as
    { state: string } | undefined;
  if (existing?.state === "complete") return receipt("already-imported");
  if (!existing) {
    jobs.create({
      id: jobId,
      kind: "import",
      accountId: parsed.accountId,
      collectionId: IMPORT_COLLECTION_ID,
    });
  } else if (
    ["paused", "partial", "failed", "auth_required", "rate_limited"].includes(existing.state)
  ) {
    jobs.resume(jobId);
  }
  const lease = jobs.acquire(jobId, options.owner, clock(), ttl);
  if (lease === null) {
    if (jobs.get(jobId).state === "cancelled") {
      throw new ImportBlockedError(`import job ${jobId} was cancelled`);
    }
    throw new ImportBlockedError(`import job ${jobId} is held by another owner`);
  }

  const passId = `import-${parsed.contentHash.slice(0, 16)}`;
  const adapter = {
    id: IMPORT_ADAPTER_ID,
    version: `xarchive-schema-${parsed.schemaVersion ?? "legacy"}`,
  };
  const pageCount = Math.max(1, Math.ceil(preview.records.length / PAGE_SIZE));
  for (let i = 0; i < pageCount; i++) {
    const nowMs = clock();
    jobs.renew(jobId, lease, nowMs, ttl);
    const page: CapturePage = {
      passId,
      accountId: parsed.accountId,
      collectionId: IMPORT_COLLECTION_ID,
      cursorIn: i === 0 ? null : `import/${i}`,
      cursorOut: i === pageCount - 1 ? null : `import/${i + 1}`,
      adapter,
      method: "import",
      records: preview.records.slice(i * PAGE_SIZE, (i + 1) * PAGE_SIZE),
    };
    const r = capture.commitPage(jobId, lease, nowMs, page, options.commitOptions);
    totals.pages++;
    totals.newRecords += r.newRecords;
    totals.newSources += r.newSources;
    totals.newVersions += r.newVersions;
    totals.weakerSkipped += r.weakerSkipped;
    totals.unavailableNoText += r.unavailableNoText;
    totals.noContentSkipped += r.noContentSkipped;
    totals.suppressed += r.suppressed;
    if (r.ended) break;
    if (r.cancelRequested || jobs.get(jobId).cancelRequested) {
      jobs.transition(jobId, lease, clock(), "cancelled", "cancelled by user");
      return receipt("cancelled");
    }
  }
  return receipt(jobs.get(jobId).state === "cancelled" ? "cancelled" : "imported");
}
