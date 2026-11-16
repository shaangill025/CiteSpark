# 0002. Canonical store

Status: Decided. Keyword latency measured on the 8 GB M1.
Requirements: CAP-03, DAT-01, DAT-02, DAT-03, RET-01, RET-02, RET-03, LAN-01, MIG-02, T01, T11, §7

## Context

The canonical store holds every entity in §7. It must commit capture pages and cursors atomically (CAP-03), keep keyword search fast on 8 GB machines (DAT-02, T11), filter trashed and excluded material at query time (RET-02), and publish rebuilt indexes atomically with rollback (RET-03). Media lives outside the store in a content-addressed blob directory (DAT-01).

## Options

| Criterion | SQLite + FTS5 (better-sqlite3) | SQLite + external search engine (Tantivy, MeiliSearch) | Embedded document DB (LevelDB, LMDB) + own index |
|---|---|---|---|
| Atomic record + cursor + index commit | One transaction covers all three. | Two systems. Needs an outbox and reconciliation. | Possible, but the index is ours to write. |
| Keyword search | FTS5 with bm25, phrase, prefix, NEAR. | Better ranking options, typo tolerance. | Must be built. |
| Footprint | In-process, one file. | Extra process or native addon. MeiliSearch is a server. | In-process. |
| Backup | Online backup API or `VACUUM INTO` gives a consistent snapshot. | Two snapshots to coordinate. | Snapshot plus own index files. |
| Licensing | SQLite public domain, better-sqlite3 MIT. | Tantivy MIT, MeiliSearch MIT. | BSD / OpenLDAP. |

## Evidence

From `prototypes/fts5-bench` on the Apple M1 8 GB machine (full numbers in `docs/f0/benchmarks.md`):

- Corpus: 100,000 synthetic posts and 15,000 articles, 216,283 chunks, 147.6 MB of text. Database file 629 MB. The `unicode61` FTS index is 53 MB.
- Warm keyword search, 1,600 timed queries across 8 query shapes, 5 runs: p50 0.43 ms, p95 54.9 ms, max 196 ms. The PROPOSED T11 target is p95 under 1 s.
- Process-cold first query (fresh process, OS cache not purged): p50 5.3 ms, p95 54 ms.
- Latency follows match count (correlation 0.88): bm25 ranks every match before `LIMIT 20`. Common-term queries are the slowest shape (p95 68 ms).
- The trigram index is 361 MB, 6.8 times the `unicode61` index, and takes 44.7 s to build.
- From `prototypes/capture-commit`: a page and its cursor commit in one `BEGIN IMMEDIATE` transaction with WAL and `synchronous=FULL`. SIGKILL at 9 crash points left no partial page and no duplicate identity.

## Decision

- SQLite through **better-sqlite3**. It bundles a pinned SQLite build with FTS5, has Electron prebuilds, and is synchronous, which suits transaction-scoped capture commits in a utility process. Pin the SQLite version and record it in diagnostics.
- WAL mode. `synchronous=FULL` for the capture and sync write paths. One writer connection, read-only reader connections.
- Schema follows §7. Store `source`, `source_version`, `observation`, `membership`, and `chunk` as relational tables. Platform identifiers stay as text (19-digit X IDs exceed JavaScript's safe integer range).
- Keyword index: an external-content FTS5 table over `chunk.text` with `tokenize='unicode61 remove_diacritics 2'`.
- Index generations (RET-03): each rebuild writes `chunk_fts_g{n}`. A single-row `index_state.active_generation` switches inside one transaction. The previous generation is kept until the new one passes checks, then dropped.
- Trash and policy filtering happen in the search query (RET-02). Do not delete rows from the index to hide them.
- Trigram index is off by default. It is an opt-in fallback for exact-substring and CJK search (LAN-01), built per generation when enabled.
- Migrations are numbered SQL files applied in a transaction, with a pre-migration backup (MIG-02).

## Consequences

- Ranking options are bm25 with column weights and our own rerank. Typo tolerance is not available. Hybrid search (ADR 0003) covers paraphrase.
- If common-term queries become slow on larger libraries, rank inside the FTS subquery (`ORDER BY rank LIMIT k`) before joining. Not needed at 100,000 posts.
- `unicode61` does not segment CJK text. Users who need it enable trigram search. Document this in the capability matrix.

## Still to validate

- Re-run the benchmark through better-sqlite3 inside Electron in M3 (F0 used `node:sqlite` on the same SQLite engine version family).
- True cold-cache numbers need a reboot or `purge` with admin rights (see `docs/f0/blockers.md`).
- End-to-end latency through IPC and rendering is measured in the M3 search screen layer.
