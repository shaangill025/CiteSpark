import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";

/** ENR-01/02: structural result of fetching one link; produced by `captureLink` in @citspark/core. */
export type LinkCapture =
  | {
      ok: true;
      finalUrl: string;
      chain: string[];
      httpStatus: number;
      title: string | null;
      canonicalUrl: string | null;
      text: string;
      contentHash: string;
      extractionMethod: string;
    }
  | { ok: false; reason: string; detail: string; chain: string[]; httpStatus: number | null };

export interface LinkRef {
  url: string;
  kind: "x_post" | "web";
  platformId?: string;
}

export type LinkStatus = "reused" | "captured" | "gap" | "known_gap";

export interface LinkOutcome {
  url: string;
  status: LinkStatus;
  sourceId: string | null;
  gapReason: string | null;
}

export interface LinkedGap {
  url: string;
  reason: string;
  detail: string | null;
  observedAt: string;
}

export interface EnrichOptions {
  /**
   * Refetch destinations whose earlier gap was transient (timeout, network, DNS, HTTP 5xx and similar,
   * and extraction capacity rejections, which say nothing about the page).
   */
  retryTransientGaps?: boolean;
}

const TRANSIENT_GAPS = new Set([
  "timeout",
  "network_error",
  "dns_failure",
  "http_error",
  "extraction_capacity",
]);

const RELATION = "links_to";

/**
 * In-flight captures by destination, shared by every store on the same connection, so overlapping
 * enrich calls fetch a destination once and each parent attaches to the shared result (ENR-01).
 * Coordination is per process and connection; separate processes rely on the persisted rows.
 */
const IN_FLIGHT = new WeakMap<Database.Database, Map<string, Promise<LinkCapture>>>();

function hostKey(url: string): string {
  return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
}

/** A page's self-declared canonical URL is trusted only on the same host, so a page cannot claim another site's identity. */
function trustedCanonical(finalUrl: string, canonical: string | null): string {
  if (canonical !== null) {
    try {
      if (hostKey(canonical) === hostKey(finalUrl)) return canonical;
    } catch {
      /* fall through */
    }
  }
  return finalUrl;
}

/**
 * Links a source to the pages and posts it mentions. Reuses exact saved sources first, fetches each missing
 * destination at most once, records explicit gaps, and never extracts links from the pages it fetched (no
 * recursive crawl, Q16).
 */
export class LinkedSourceStore {
  readonly #db: Database.Database;
  readonly #capture: (url: string) => Promise<LinkCapture>;

  constructor(db: Database.Database, capture: (url: string) => Promise<LinkCapture>) {
    this.#db = db;
    this.#capture = capture;
  }

  /** Link `sourceId` to each given link. Only the supplied links are followed; fetched pages are never mined for more. */
  async enrich(
    sourceId: string,
    links: readonly LinkRef[],
    options: EnrichOptions = {},
  ): Promise<LinkOutcome[]> {
    const outcomes: LinkOutcome[] = [];
    for (const link of links) outcomes.push(await this.#one(sourceId, link, options));
    return outcomes;
  }

  gaps(sourceId: string): LinkedGap[] {
    return this.#db
      .prepare(
        `SELECT f.original_url url, f.gap_reason reason, f.gap_detail detail, f.observed_at observedAt
           FROM link_ref r JOIN linked_fetch f ON f.original_url = r.original_url
           WHERE r.source_id = ? AND f.gap_reason IS NOT NULL ORDER BY f.id`,
      )
      .all(sourceId) as LinkedGap[];
  }

  async #one(parent: string, link: LinkRef, options: EnrichOptions): Promise<LinkOutcome> {
    const saved = this.#findSaved(link);
    if (saved) return this.#attach(parent, link.url, saved, "reused");

    const prior = this.#db
      .prepare("SELECT source_id, gap_reason FROM linked_fetch WHERE original_url = ?")
      .get(link.url) as { source_id: string | null; gap_reason: string | null } | undefined;
    if (prior?.source_id) return this.#attach(parent, link.url, prior.source_id, "reused");
    const retry =
      options.retryTransientGaps === true && TRANSIENT_GAPS.has(prior?.gap_reason ?? "");
    if (prior && !retry) {
      this.#ref(parent, link.url);
      return { url: link.url, status: "known_gap", sourceId: null, gapReason: prior.gap_reason };
    }

    if (link.kind === "x_post" && !prior) {
      // Web fetchers cannot read X; saving the post needs the capture adapter, so keep an explicit gap.
      this.#recordGap(
        parent,
        link.url,
        "x_post_not_saved",
        `X post ${link.platformId ?? ""} is not in the library`,
      );
      return { url: link.url, status: "gap", sourceId: null, gapReason: "x_post_not_saved" };
    }

    if (link.kind === "x_post") {
      return {
        url: link.url,
        status: "known_gap",
        sourceId: null,
        gapReason: prior?.gap_reason ?? null,
      };
    }
    return this.#captureOnce(parent, link.url);
  }

  /**
   * Start or join the single in-flight capture of `url` and persist its result for `parent`. The
   * owner stores synchronously after its capture settles and only then releases the entry, so any
   * later caller sees either the in-flight capture or the stored row; joiners attach to the same
   * result through the raced path in `#store` (or the idempotent gap upsert).
   */
  async #captureOnce(parent: string, url: string): Promise<LinkOutcome> {
    let flights = IN_FLIGHT.get(this.#db);
    if (!flights) {
      flights = new Map();
      IN_FLIGHT.set(this.#db, flights);
    }
    const joined = flights.get(url);
    if (joined) return this.#persist(parent, url, await joined);
    const started = Promise.resolve().then(() => this.#capture(url));
    flights.set(url, started);
    try {
      return this.#persist(parent, url, await started);
    } finally {
      if (flights.get(url) === started) flights.delete(url);
    }
  }

  #persist(parent: string, url: string, cap: LinkCapture): LinkOutcome {
    if (!cap.ok) {
      this.#recordGap(parent, url, cap.reason, cap.detail, cap);
      return { url, status: "gap", sourceId: null, gapReason: cap.reason };
    }
    return this.#store(parent, url, cap);
  }

  #findSaved(link: LinkRef): string | null {
    const row = (
      link.kind === "x_post"
        ? this.#db
            .prepare(
              "SELECT id FROM source WHERE source_type = 'x_post' AND platform_id = ? AND trashed_at IS NULL",
            )
            .get(link.platformId)
        : this.#db
            .prepare("SELECT id FROM source WHERE canonical_url = ? AND trashed_at IS NULL")
            .get(link.url)
    ) as { id: string } | undefined;
    return row?.id ?? null;
  }

  #ref(parent: string, url: string): void {
    this.#db
      .prepare("INSERT OR IGNORE INTO link_ref (source_id, original_url) VALUES (?, ?)")
      .run(parent, url);
  }

  #attach(parent: string, url: string, target: string, status: LinkStatus): LinkOutcome {
    this.#db.transaction(() => {
      this.#ensureFetchRow(url, target);
      this.#ref(parent, url);
      this.#relate(parent, target, url);
    })();
    return { url, status, sourceId: target, gapReason: null };
  }

  /** Reused saved sources get a provenance row too, so later lookups and gap queries see them. */
  #ensureFetchRow(url: string, target: string): void {
    this.#db
      .prepare(
        `INSERT INTO linked_fetch (original_url, source_id, final_url) VALUES (?, ?, ?)
         ON CONFLICT (original_url) DO UPDATE SET source_id = excluded.source_id,
           final_url = excluded.final_url, gap_reason = NULL, gap_detail = NULL
         WHERE linked_fetch.source_id IS NULL`,
      )
      .run(url, target, url);
  }

  #relate(parent: string, target: string, url: string): void {
    if (parent === target) return;
    const exists = this.#db
      .prepare("SELECT 1 FROM relationship WHERE from_id = ? AND to_id = ? AND type = ?")
      .get(parent, target, RELATION);
    if (!exists) {
      this.#db
        .prepare(
          "INSERT INTO relationship (from_id, to_id, type, origin, evidence) VALUES (?, ?, ?, 'captured', ?)",
        )
        .run(parent, target, RELATION, JSON.stringify({ url }));
    }
  }

  #recordGap(
    parent: string,
    url: string,
    reason: string,
    detail: string,
    cap?: { chain: string[]; httpStatus: number | null },
  ): void {
    this.#db.transaction(() => {
      this.#db
        .prepare(
          `INSERT INTO linked_fetch (original_url, gap_reason, gap_detail, redirect_chain, http_status)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (original_url) DO UPDATE SET gap_reason = excluded.gap_reason,
             gap_detail = excluded.gap_detail, redirect_chain = excluded.redirect_chain,
             http_status = excluded.http_status,
             observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
           WHERE linked_fetch.source_id IS NULL`,
        )
        .run(url, reason, detail, cap ? JSON.stringify(cap.chain) : null, cap?.httpStatus ?? null);
      this.#ref(parent, url);
    })();
  }

  #store(parent: string, url: string, cap: Extract<LinkCapture, { ok: true }>): LinkOutcome {
    const canonical = trustedCanonical(cap.finalUrl, cap.canonicalUrl);
    return this.#db.transaction((): LinkOutcome => {
      const raced = this.#db
        .prepare(
          "SELECT source_id FROM linked_fetch WHERE original_url = ? AND source_id IS NOT NULL",
        )
        .get(url) as { source_id: string } | undefined;
      if (raced) {
        this.#ref(parent, url);
        this.#relate(parent, raced.source_id, url);
        return { url, status: "reused", sourceId: raced.source_id, gapReason: null };
      }
      const existing = this.#db
        .prepare(
          "SELECT id FROM source WHERE canonical_url IN (?, ?) AND trashed_at IS NULL ORDER BY created_at LIMIT 1",
        )
        .get(canonical, cap.finalUrl) as { id: string } | undefined;
      let target = existing?.id;
      let status: LinkStatus = "reused";
      if (!target) {
        target = randomUUID();
        status = "captured";
        this.#db
          .prepare("INSERT INTO source (id, source_type, canonical_url) VALUES (?, 'article', ?)")
          .run(target, canonical);
      }
      // Snapshots are immutable and keyed by (source, content hash): an existing source whose page
      // changed gains a new version; unchanged content reuses its version. Either way this capture
      // is observed, so the provenance row below always has a matching stored snapshot (ENR-02).
      this.#db
        .prepare(
          `INSERT INTO source_version (source_id, content_hash, text, completeness)
           VALUES (?, ?, ?, 'unknown') ON CONFLICT (source_id, content_hash) DO NOTHING`,
        )
        .run(target, cap.contentHash, cap.text);
      const version = this.#db
        .prepare("SELECT id FROM source_version WHERE source_id = ? AND content_hash = ?")
        .get(target, cap.contentHash) as { id: number };
      this.#db
        .prepare(
          `INSERT INTO observation (source_id, version_id, method, evidence)
           VALUES (?, ?, ?, ?)`,
        )
        .run(
          target,
          version.id,
          cap.extractionMethod,
          JSON.stringify({ originalUrl: url, finalUrl: cap.finalUrl, chain: cap.chain }),
        );
      this.#db
        .prepare(
          `INSERT INTO linked_fetch (original_url, source_id, final_url, canonical_url, redirect_chain, title,
             content_hash, extraction_method, http_status)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (original_url) DO UPDATE SET source_id = excluded.source_id,
             final_url = excluded.final_url, canonical_url = excluded.canonical_url,
             redirect_chain = excluded.redirect_chain, title = excluded.title,
             content_hash = excluded.content_hash, extraction_method = excluded.extraction_method,
             http_status = excluded.http_status, gap_reason = NULL, gap_detail = NULL,
             observed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
        )
        .run(
          url,
          target,
          cap.finalUrl,
          cap.canonicalUrl,
          JSON.stringify(cap.chain),
          cap.title,
          cap.contentHash,
          cap.extractionMethod,
          cap.httpStatus,
        );
      this.#ref(parent, url);
      this.#relate(parent, target, url);
      return { url, status, sourceId: target, gapReason: null };
    })();
  }
}
