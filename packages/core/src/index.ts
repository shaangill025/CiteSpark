// Core logic lands layer by layer; this package stays free of Electron imports.
export const CORE_PACKAGE = "@citspark/core";
export { bareHostname, isBlockedAddress, screenUrl, type UrlRejection } from "./ssrf.ts";
export {
  DEFAULT_FETCH_LIMITS,
  guardedFetch,
  type FetchGap,
  type FetchLimits,
  type FetchResult,
  type FetchedPage,
  type GapReason,
  type GuardedFetchOptions,
} from "./fetcher.ts";
export {
  EXTRACTION_METHOD,
  extractLinks,
  extractPage,
  xPostId,
  type ExtractedLink,
  type PageContent,
} from "./links.ts";
export { captureLink, type CaptureOptions, type CaptureResult } from "./capture.ts";
export {
  DEFAULT_EXTRACTION_LIMITS,
  ExtractionPool,
  defaultExtractionPool,
  type ExtractionPoolLimits,
  type IsolatedExtraction,
} from "./extract-isolated.ts";
export * from "./ipc/index.ts";
export {
  captureHandlers,
  xAccountKey,
  X_CAPTURE_KIND,
  type CaptureHandlerOptions,
} from "./capture-ipc.ts";
