import { decodeBody } from "./decode.ts";
import { guardedFetch, type GapReason, type GuardedFetchOptions } from "./fetcher.ts";
import { ExtractionLimitError, extractPage, type PageContent } from "./links.ts";

export type CaptureResult =
  | ({
      ok: true;
      originalUrl: string;
      finalUrl: string;
      chain: string[];
      httpStatus: number;
    } & PageContent)
  | { ok: false; reason: GapReason; detail: string; chain: string[]; httpStatus: number | null };

/**
 * Fetch one linked URL under the SSRF guards, decode it with its declared or sniffed encoding, and
 * extract sanitized text and metadata. Unsupported or invalid encodings are explicit gaps, never
 * replacement-character text. Never crawls further.
 */
export async function captureLink(
  url: string,
  options: GuardedFetchOptions = {},
): Promise<CaptureResult> {
  const r = await guardedFetch(url, options);
  if (!r.ok) return r;
  const decoded = decodeBody(r.body, r.contentType, r.charset);
  if (!decoded.ok) {
    return {
      ok: false,
      reason: decoded.reason,
      detail: decoded.detail,
      chain: r.chain,
      httpStatus: r.httpStatus,
    };
  }
  let page: PageContent;
  try {
    page = extractPage(decoded.text, r.contentType, r.finalUrl);
  } catch (error) {
    // Only the extractor's own resource bound becomes a gap; any other failure is a defect and propagates.
    if (!(error instanceof ExtractionLimitError)) throw error;
    return {
      ok: false,
      reason: "extraction_limit",
      detail: error.message,
      chain: r.chain,
      httpStatus: r.httpStatus,
    };
  }
  if (page.text === "") {
    return {
      ok: false,
      reason: "empty_content",
      detail: "no extractable text",
      chain: r.chain,
      httpStatus: r.httpStatus,
    };
  }
  return {
    ok: true,
    originalUrl: r.originalUrl,
    finalUrl: r.finalUrl,
    chain: r.chain,
    httpStatus: r.httpStatus,
    ...page,
  };
}
