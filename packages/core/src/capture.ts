import { defaultExtractionPool, type ExtractionPool } from "./extract-isolated.ts";
import {
  DEFAULT_FETCH_LIMITS,
  guardedFetch,
  type GapReason,
  type GuardedFetchOptions,
} from "./fetcher.ts";
import type { PageContent } from "./links.ts";

export type CaptureResult =
  | ({
      ok: true;
      originalUrl: string;
      finalUrl: string;
      chain: string[];
      httpStatus: number;
    } & PageContent)
  | { ok: false; reason: GapReason; detail: string; chain: string[]; httpStatus: number | null };

export interface CaptureOptions extends GuardedFetchOptions {
  /** Pool that bounds extraction workers; defaults to the process-wide pool. */
  extractionPool?: ExtractionPool;
}

/**
 * Fetch one linked URL under the SSRF guards, then decode and extract it in an isolated worker.
 * `timeoutMs` bounds the whole capture: the fetch, waiting for and starting the worker, and the
 * worker's decode and parse share one deadline; a worker still running at the deadline is terminated
 * and reported as a `timeout` gap. Unsupported or invalid encodings are explicit gaps, never
 * replacement-character text. Never crawls further.
 */
export async function captureLink(
  url: string,
  options: CaptureOptions = {},
): Promise<CaptureResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_LIMITS.timeoutMs;
  const deadlineAt = performance.now() + timeoutMs;
  const r = await guardedFetch(url, options);
  if (!r.ok) return r;
  const gap = (reason: GapReason, detail: string): CaptureResult => ({
    ok: false,
    reason,
    detail,
    chain: r.chain,
    httpStatus: r.httpStatus,
  });
  const pool = options.extractionPool ?? defaultExtractionPool;
  const extracted = await pool.extract(
    { body: r.body, contentType: r.contentType, charset: r.charset, finalUrl: r.finalUrl },
    deadlineAt,
  );
  if (extracted.kind === "deadline") {
    return gap("timeout", `extraction did not finish within the overall ${timeoutMs} ms deadline`);
  }
  if (extracted.kind === "busy") {
    return gap("extraction_capacity", "all extraction workers are busy; the page was not examined");
  }
  if (extracted.kind === "gap") return gap(extracted.reason, extracted.detail);
  const page = extracted.page;
  if (page.text === "") return gap("empty_content", "no extractable text");
  return {
    ok: true,
    originalUrl: r.originalUrl,
    finalUrl: r.finalUrl,
    chain: r.chain,
    httpStatus: r.httpStatus,
    ...page,
  };
}
