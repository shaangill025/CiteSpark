import type { PageContent } from "./links.ts";

/** Messages between `extract-isolated.ts` and its worker entry `extract-worker.ts`. Types only. */

/** One fetched body to decode and extract inside the worker. */
export interface ExtractionInput {
  body: Uint8Array;
  contentType: string;
  charset: string | null;
  finalUrl: string;
}

/** The worker's single reply. */
export type WorkerReply =
  | { kind: "page"; page: PageContent }
  | {
      kind: "gap";
      reason: "unsupported_charset" | "invalid_text_encoding" | "extraction_limit";
      detail: string;
    };
