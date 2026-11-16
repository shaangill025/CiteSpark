import { guardedFetch, type GapReason, type GuardedFetchOptions } from "./fetcher.ts";
import { extractPage, type PageContent } from "./links.ts";

export type CaptureResult =
  | ({
      ok: true;
      originalUrl: string;
      finalUrl: string;
      chain: string[];
      httpStatus: number;
    } & PageContent)
  | { ok: false; reason: GapReason; detail: string; chain: string[]; httpStatus: number | null };

/** Fetch one linked URL under the SSRF guards and extract sanitized text and metadata. Never crawls further. */
export async function captureLink(
  url: string,
  options: GuardedFetchOptions = {},
): Promise<CaptureResult> {
  const r = await guardedFetch(url, options);
  if (!r.ok) return r;
  const page = extractPage(r.body.toString("utf8"), r.contentType, r.finalUrl);
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
