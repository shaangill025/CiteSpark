import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { DEFAULT_CHUNKER, chunkText, type ChunkerOptions } from "./chunker.ts";

/**
 * Keyword index generations (RET-03, MIG-02, ADR 0002). A rebuild writes a new generation beside the active
 * one: its own chunk rows, a view over them, and external-content FTS5 tables. It becomes searchable only
 * when one transaction moves `index_state.active_generation` to it, after verification. The previous
 * generation stays intact so `rollback` can restore its results until it is explicitly dropped.
 *
 * One writer: run builds, switches, and `indexPending` from the single writer connection.
 */

export const TOKENIZER = "unicode61 remove_diacritics 2";

export type GenerationState = "building" | "ready" | "active" | "retired" | "failed" | "dropped";
export type IndexFaultPoint = "mid-build" | "before-switch" | "mid-switch" | "after-switch";

export interface BuildOptions {
  /** Opt-in trigram index for exact substring and CJK search (LAN-01). About 7x the keyword index. */
  trigram?: boolean;
  chunker?: Partial<Omit<ChunkerOptions, "algorithm">>;
  /** Versions per write transaction; bounds memory and writer hold time (DAT-01, DAT-02). */
  batchSize?: number;
  /** Test seam for crash injection. `mid-build` fires inside the second chunk batch transaction. */
  onFaultPoint?: (point: IndexFaultPoint) => void;
}

export interface SwitchOptions {
  batchSize?: number;
  /** Test seam: `before-switch` and `mid-switch` fire inside the switch transaction, `after-switch` after it. */
  onFaultPoint?: (point: IndexFaultPoint) => void;
}

export interface GenerationInfo {
  generation: number;
  state: GenerationState;
  tokenizer: string;
  trigram: boolean;
  chunker: ChunkerOptions;
  chunkCount: number;
  createdAt: string;
  verifiedAt: string | null;
  activatedAt: string | null;
}

export interface SearchOptions {
  limit?: number;
  /** `keyword`: all terms, bm25-ranked. `substring`: exact substring via the trigram index, if built. */
  mode?: "keyword" | "substring";
}

/** One result with everything needed to cite and reopen the exact passage (RET-03). */
export interface SearchHit {
  chunkId: number;
  sourceId: string;
  versionId: number;
  /** UTF-16 offsets into the version text: `versionText.slice(start, end) === text`. */
  start: number;
  end: number;
  text: string;
  documentType: string;
  canonicalUrl: string | null;
  /** Capture limits recorded for the version. */
  completeness: string;
  generation: number;
  /** bm25 score for keyword mode (lower is better); null for substring mode, which is unranked. */
  score: number | null;
}

export class GenerationStateError extends Error {}
export class GenerationVerificationError extends Error {}
export class TrigramUnavailableError extends Error {}

const DEFAULT_BATCH = 500;
const MIN_TRIGRAM_CHARS = 3;

interface GenerationRow {
  generation: number;
  state: GenerationState;
  tokenizer: string;
  trigram: number;
  chunker: string;
  chunk_count: number;
  created_at: string;
  verified_at: string | null;
  activated_at: string | null;
}

interface PendingRow {
  id: number;
  text: string;
  source_type: string;
}

const names = (g: number) => {
  if (!Number.isSafeInteger(g) || g < 1) throw new RangeError(`invalid generation ${g}`);
  return { view: `chunk_g${g}`, fts: `chunk_fts_g${g}`, tri: `chunk_tri_g${g}` };
};

const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");

export class IndexStore {
  readonly #db: Database.Database;

  constructor(db: Database.Database) {
    this.#db = db;
  }

  /** The generation searches read, or 0 before the first switch. */
  active(): number {
    return this.#state().active;
  }

  /** The generation `rollback` restores, if it is still intact. */
  previous(): number | null {
    return this.#state().previous;
  }

  generation(g: number): GenerationInfo {
    const row = this.#db.prepare("SELECT * FROM index_generation WHERE generation = ?").get(g) as
      GenerationRow | undefined;
    if (!row) throw new GenerationStateError(`unknown generation ${g}`);
    return toInfo(row);
  }

  generations(): GenerationInfo[] {
    const rows = this.#db
      .prepare("SELECT * FROM index_generation ORDER BY generation")
      .all() as GenerationRow[];
    return rows.map(toInfo);
  }

  /** Builds and verifies a candidate generation. The active generation keeps serving searches meanwhile. */
  build(options: BuildOptions = {}): number {
    const chunker: ChunkerOptions = {
      ...DEFAULT_CHUNKER,
      ...options.chunker,
      algorithm: "boundary-v1",
    };
    chunkText("", chunker); // validates the options before anything is written
    const trigram = options.trigram === true;
    const g = this.#db
      .transaction(() => {
        const next = (
          this.#db
            .prepare("SELECT COALESCE(MAX(generation), 0) + 1 g FROM index_generation")
            .get() as { g: number }
        ).g;
        this.#db
          .prepare(
            "INSERT INTO index_generation (generation, state, tokenizer, trigram, chunker) VALUES (?, 'building', ?, ?, ?)",
          )
          .run(next, TOKENIZER, trigram ? 1 : 0, JSON.stringify(chunker));
        return next;
      })
      .immediate();

    // Bulk-load chunk rows first, then build the FTS tables from them in one pass (faster than per-row).
    this.#catchUp(g, chunker, false, options.batchSize, options.onFaultPoint);
    const { view, fts, tri } = names(g);
    this.#db
      .transaction(() => {
        this.#db.exec(
          `CREATE VIEW ${view} AS SELECT id, text FROM chunk WHERE index_generation = ${g};
           CREATE VIRTUAL TABLE ${fts} USING fts5(text, content='${view}', content_rowid='id', tokenize='${TOKENIZER}');
           INSERT INTO ${fts} (${fts}) VALUES ('rebuild');`,
        );
        if (trigram) {
          this.#db.exec(
            `CREATE VIRTUAL TABLE ${tri} USING fts5(text, content='${view}', content_rowid='id', tokenize='trigram');
             INSERT INTO ${tri} (${tri}) VALUES ('rebuild');`,
          );
        }
      })
      .immediate();
    // Versions committed by capture while the bulk load ran.
    this.#catchUp(g, chunker, true, options.batchSize);
    try {
      this.verify(g);
    } catch (e) {
      this.#dropArtifacts(g, "failed");
      throw e;
    }
    this.#db
      .prepare(
        "UPDATE index_generation SET state = 'ready', verified_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE generation = ?",
      )
      .run(g);
    return g;
  }

  /**
   * Checks a generation before it is switched in (MIG-02): every version covered, chunk counts consistent,
   * every chunk's offsets reproduce its text and hash, and the FTS tables match their content.
   */
  verify(g: number): void {
    const info = this.generation(g);
    if (info.state === "failed" || info.state === "dropped") {
      throw new GenerationStateError(`generation ${g} is ${info.state}`);
    }
    const fail = (msg: string): never => {
      throw new GenerationVerificationError(`generation ${g}: ${msg}`);
    };
    const missing = (
      this.#db
        .prepare(
          `SELECT COUNT(*) n FROM source_version v WHERE NOT EXISTS
             (SELECT 1 FROM index_coverage ic WHERE ic.generation = ? AND ic.version_id = v.id)`,
        )
        .get(g) as { n: number }
    ).n;
    if (missing > 0) fail(`${missing} versions not indexed`);
    const counts = this.#db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM chunk WHERE index_generation = @g) chunks,
                (SELECT COALESCE(SUM(chunk_count), 0) FROM index_coverage WHERE generation = @g) covered`,
      )
      .get({ g }) as { chunks: number; covered: number };
    if (counts.chunks !== counts.covered || counts.chunks !== info.chunkCount) {
      fail(`chunk count ${counts.chunks}, coverage ${counts.covered}, recorded ${info.chunkCount}`);
    }

    // Exact citation targets. Streams rows so memory stays bounded; one version's text at a time.
    const rows = this.#db
      .prepare(
        `SELECT c.id, c.version_id, c.char_start, c.char_end, c.text, c.text_hash
           FROM chunk c WHERE c.index_generation = ? ORDER BY c.version_id, c.char_start`,
      )
      .iterate(g) as IterableIterator<{
      id: number;
      version_id: number;
      char_start: number;
      char_end: number;
      text: string;
      text_hash: string;
    }>;
    const versionText = this.#db.prepare("SELECT text FROM source_version WHERE id = ?").pluck();
    let cachedId = -1;
    let cached = "";
    for (const c of rows) {
      if (c.version_id !== cachedId) {
        cachedId = c.version_id;
        cached = versionText.get(c.version_id) as string;
      }
      if (cached.slice(c.char_start, c.char_end) !== c.text)
        fail(`chunk ${c.id} offsets do not match`);
      if (sha256(c.text) !== c.text_hash) fail(`chunk ${c.id} hash does not match`);
    }

    const { fts, tri } = names(g);
    const tables = info.trigram ? [fts, tri] : [fts];
    for (const t of tables) {
      if (!this.#tableExists(t)) fail(`${t} is missing`);
      try {
        this.#db.prepare(`INSERT INTO ${t} (${t}, rank) VALUES ('integrity-check', 1)`).run();
      } catch (e) {
        fail(`${t} does not match its content: ${(e as Error).message}`);
      }
    }
  }

  /**
   * Makes `g` the active generation in one transaction, after indexing versions it has not seen and
   * verifying it. The generation it replaces becomes `previous` and stays intact for `rollback`.
   */
  activate(g: number, options: SwitchOptions = {}): void {
    const info = this.generation(g);
    // Already active (for example a retry after a crash once the switch committed): nothing to do.
    if (this.active() === g) return;
    if (info.state !== "ready" && info.state !== "retired") {
      throw new GenerationStateError(`generation ${g} is ${info.state}, not ready`);
    }
    this.#catchUp(g, info.chunker, true, options.batchSize);
    this.verify(g);
    const fault = options.onFaultPoint ?? (() => {});
    this.#db
      .transaction(() => {
        // A version committed since the last batch is indexed inside the switch, so none is skipped.
        this.#catchUp(g, info.chunker, true, options.batchSize, undefined, false);
        const missing = this.#db
          .prepare(
            `SELECT 1 FROM source_version v WHERE NOT EXISTS
               (SELECT 1 FROM index_coverage ic WHERE ic.generation = ? AND ic.version_id = v.id) LIMIT 1`,
          )
          .get(g);
        if (missing) throw new GenerationVerificationError(`generation ${g}: versions not indexed`);
        const old = this.active();
        fault("before-switch");
        this.#db
          .prepare(
            "UPDATE index_state SET active_generation = ?, previous_generation = ? WHERE id = 1",
          )
          .run(g, old === 0 ? null : old);
        fault("mid-switch");
        this.#db
          .prepare("UPDATE index_generation SET state = 'retired' WHERE generation = ?")
          .run(old);
        this.#db
          .prepare(
            "UPDATE index_generation SET state = 'active', activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE generation = ?",
          )
          .run(g);
      })
      .immediate();
    fault("after-switch");
  }

  /** Switches back to the previous generation, restoring its results. Returns the restored generation. */
  rollback(options: SwitchOptions = {}): number {
    const prev = this.previous();
    if (prev === null) throw new GenerationStateError("no previous generation to roll back to");
    this.activate(prev, options);
    return prev;
  }

  /** Drops a generation that is not active. Dropping the previous generation ends rollback to it. */
  drop(g: number): void {
    const info = this.generation(g);
    if (info.state === "active") throw new GenerationStateError(`generation ${g} is active`);
    if (info.state === "dropped") return;
    this.#dropArtifacts(g, "dropped");
  }

  /**
   * Cleans up builds a crash interrupted: their partial chunks and tables are removed and they are marked
   * `failed`. Call at writer start-up, before any new build. Returns the generations cleaned.
   */
  recover(): number[] {
    const stale = this.#db
      .prepare(
        "SELECT generation FROM index_generation WHERE state = 'building' ORDER BY generation",
      )
      .pluck()
      .all() as number[];
    for (const g of stale) this.#dropArtifacts(g, "failed");
    return stale;
  }

  /** Incremental indexing (DAT-01): chunks versions the active generation has not seen yet. */
  indexPending(options: { batchSize?: number } = {}): number {
    const g = this.active();
    if (g === 0) return 0;
    return this.#catchUp(g, this.generation(g).chunker, true, options.batchSize);
  }

  /** Searches the active generation. Trashed sources are excluded at query time (RET-02). */
  search(query: string, options: SearchOptions = {}): SearchHit[] {
    const limit = options.limit ?? 20;
    const mode = options.mode ?? "keyword";
    // One read transaction: the generation looked up is the one queried, even if a switch commits meanwhile.
    return this.#db.transaction((): SearchHit[] => {
      const g = this.active();
      if (g === 0) return [];
      const { fts, tri } = names(g);
      let table = fts;
      let match: string | null;
      if (mode === "substring") {
        // The recorded mode of the active generation decides, not a process setting (F0 trigram bug).
        if (!this.generation(g).trigram) {
          throw new TrigramUnavailableError(`generation ${g} has no trigram index`);
        }
        table = tri;
        match = [...query].length >= MIN_TRIGRAM_CHARS ? quote(query) : null;
      } else {
        match = keywordQuery(query);
      }
      if (match === null) return [];
      const ranked = mode === "keyword";
      const rows = this.#db
        .prepare(
          `SELECT c.id chunkId, s.id sourceId, c.version_id versionId, c.char_start start, c.char_end "end",
                  c.text, c.document_type documentType, s.canonical_url canonicalUrl,
                  v.completeness, ${ranked ? `bm25(${table})` : "NULL"} score
             FROM ${table} f
             JOIN chunk c ON c.id = f.rowid
             JOIN source_version v ON v.id = c.version_id
             JOIN source s ON s.id = v.source_id
            WHERE ${table} MATCH ? AND s.trashed_at IS NULL
            ORDER BY ${ranked ? "score," : ""} c.id
            LIMIT ?`,
        )
        .all(match, limit) as Omit<SearchHit, "generation">[];
      return rows.map((r) => ({ ...r, generation: g }));
    })();
  }

  #state(): { active: number; previous: number | null } {
    const row = this.#db
      .prepare("SELECT active_generation a, previous_generation p FROM index_state WHERE id = 1")
      .get() as { a: number; p: number | null };
    return { active: row.a, previous: row.p };
  }

  #tableExists(name: string): boolean {
    return this.#db.prepare("SELECT 1 FROM sqlite_schema WHERE name = ?").get(name) !== undefined;
  }

  /**
   * Chunks every version generation `g` has not covered, in batches. With `fts`, rows also go into the
   * generation's FTS tables. With `ownTransaction` false the caller's transaction wraps the work.
   */
  #catchUp(
    g: number,
    chunker: ChunkerOptions,
    fts: boolean,
    batchSize = DEFAULT_BATCH,
    onFaultPoint?: (point: IndexFaultPoint) => void,
    ownTransaction = true,
  ): number {
    const { fts: ftsName, tri } = names(g);
    const trigram = fts && this.#tableExists(tri);
    const pending = this.#db.prepare(
      `SELECT v.id, v.text, s.source_type FROM source_version v JOIN source s ON s.id = v.source_id
        WHERE v.id > ? AND NOT EXISTS
          (SELECT 1 FROM index_coverage ic WHERE ic.generation = ? AND ic.version_id = v.id)
        ORDER BY v.id LIMIT ?`,
    );
    const insChunk = this.#db.prepare(
      `INSERT INTO chunk (version_id, char_start, char_end, text, text_hash, document_type, index_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const insFts = fts
      ? this.#db.prepare(`INSERT INTO ${ftsName} (rowid, text) VALUES (?, ?)`)
      : null;
    const insTri = trigram
      ? this.#db.prepare(`INSERT INTO ${tri} (rowid, text) VALUES (?, ?)`)
      : null;
    const insCoverage = this.#db.prepare(
      "INSERT INTO index_coverage (generation, version_id, chunk_count) VALUES (?, ?, ?)",
    );
    const addCount = this.#db.prepare(
      "UPDATE index_generation SET chunk_count = chunk_count + ? WHERE generation = ?",
    );

    let after = 0;
    let indexed = 0;
    let batches = 0;
    for (;;) {
      const batch = (): number => {
        const rows = pending.all(after, g, batchSize) as PendingRow[];
        let added = 0;
        for (const v of rows) {
          const spans = chunkText(v.text, chunker);
          for (const s of spans) {
            const id = insChunk.run(
              v.id,
              s.start,
              s.end,
              s.text,
              sha256(s.text),
              v.source_type,
              g,
            ).lastInsertRowid;
            insFts?.run(id, s.text);
            insTri?.run(id, s.text);
          }
          insCoverage.run(g, v.id, spans.length);
          added += spans.length;
        }
        if (added > 0) addCount.run(added, g);
        // Fires in the second batch, so a crash there leaves committed chunks of a partial build behind.
        if (batches++ === 1) onFaultPoint?.("mid-build");
        if (rows.length > 0) after = rows.at(-1)!.id;
        return rows.length;
      };
      const n = ownTransaction ? this.#db.transaction(batch).immediate() : batch();
      indexed += n;
      if (n < batchSize) return indexed;
    }
  }

  #dropArtifacts(g: number, finalState: "failed" | "dropped"): void {
    const { view, fts, tri } = names(g);
    this.#db
      .transaction(() => {
        this.#db.exec(
          `DROP TABLE IF EXISTS ${tri}; DROP TABLE IF EXISTS ${fts}; DROP VIEW IF EXISTS ${view};`,
        );
        this.#db.prepare("DELETE FROM index_coverage WHERE generation = ?").run(g);
        this.#db.prepare("DELETE FROM chunk WHERE index_generation = ?").run(g);
        this.#db
          .prepare("UPDATE index_generation SET state = ?, chunk_count = 0 WHERE generation = ?")
          .run(finalState, g);
        this.#db
          .prepare(
            "UPDATE index_state SET previous_generation = NULL WHERE id = 1 AND previous_generation = ?",
          )
          .run(g);
      })
      .immediate();
  }
}

function toInfo(r: GenerationRow): GenerationInfo {
  return {
    generation: r.generation,
    state: r.state,
    tokenizer: r.tokenizer,
    trigram: r.trigram === 1,
    chunker: JSON.parse(r.chunker) as ChunkerOptions,
    chunkCount: r.chunk_count,
    createdAt: r.created_at,
    verifiedAt: r.verified_at,
    activatedAt: r.activated_at,
  };
}

const quote = (s: string) => `"${s.replaceAll('"', '""')}"`;

/** Treats user input as literal terms (implicit AND) so FTS5 syntax characters cannot cause errors. */
function keywordQuery(query: string): string | null {
  const terms = query.split(/\s+/u).filter((t) => /[\p{L}\p{N}]/u.test(t));
  return terms.length === 0 ? null : terms.map(quote).join(" ");
}
