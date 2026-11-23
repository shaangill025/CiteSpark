# Traceability matrix

Maps every requirement in [the specification](citspark-spec-v1.0.md) to a milestone and acceptance tests.
Milestone and test assignments are a **proposed** planning aid (L0); the spec's section 15/16 text is authoritative.
Update `Status` in the PR that changes it. Allowed values: `not started`, `in progress`, `implemented`, `verified`. Milestones also use `complete` once their exit criterion is met.

`Plan layers` come from the owner-approved [implementation plan](../f0/implementation-plan.md). `F0 evidence` is design or prototype evidence only. A requirement stays `not started` until production code and tests exist.

## Requirements

| ID | Summary | Milestone | Acceptance tests | Plan layers | Status | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| CAP-01 | Versioned capture adapters; audited collector evaluation | F0, M1 | T01, T02 | M1-07, M1-08 | in progress | M1-07: versioned `CaptureAdapter` in `packages/capture-x` (passive parse, ADR 0005; synthetic fixtures); real-session capture unvalidated. F0 licence/dependency audit of xarchive and twitter-web-exporter. F0: ADR 0005; collector licence, dependency, and network audit in `docs/f0/license-inventory.md` |
| CAP-02 | String platform IDs; account-bound membership; account-switch pause | M1 | T01, T02 | M1-02, M1-04 | in progress | M1-02: string IDs and account-scoped membership schema (`packages/store`). M1-04: `CaptureStore.commitPage` refuses a page bound to another account or collection before any capture write and pauses the job in the same lease-checked transaction; records attach to the persisted ID of their `(source_type, platform_id)` identity, never to another identity's row (`packages/store/src/capture.ts`, `capture.test.ts`). Account detection in the extension pending (M1-08). F0: `prototypes/capture-commit` |
| CAP-03 | Atomic record+cursor commit; idempotent replay; lease | M1 | T01 | M1-03, M1-04 | implemented | M1-03: exclusive per-collection leases, acquisition-generation fencing and durable checkpoints (`packages/store/src/jobs.ts`, `jobs.test.ts`); 50 seeded operation sequences. M1-04: records, page, pass cursor and job cursor commit in one IMMEDIATE transaction fenced by the retained `acquire` token through `JobStore.withLease` (check and work share the transaction); replay keyed on pass and cursor, a fresh pass with new cursors adds no canonical rows (ADR 0005); cursor-mismatch, skip and stale-generation rejection (`packages/store/src/capture.ts`); T01 in `packages/store/src/t01.test.ts`. |
| CAP-04 | Pause/resume/cancel and failure outcomes; loop, schema, disk detection | M1 | T02, T15 | M1-03, M2-02, M2-11, M2-12 | in progress | M1-03: pause/resume/retry and cooperative cancellation preserve committed records; pending cancel wins over resumable/complete outcomes and resume cannot revoke a running lease. Loop/schema/disk detection pending. |
| CAP-05 | Retry-After, bounded backoff, no auth bypass | M1 | T02 | M1-08, M2-11 | not started |  |
| CAP-06 | Honest 'complete' definition and termination evidence | M1 | T02 | M1-03, M1-04 | in progress | M1-03: complete is a distinct terminal state with stop reason. M1-04: a page without a continuation completes the job in the same transaction; committed pages, passes, distinct IDs, adapter versions and the terminating page are recorded (`CaptureStore.summary`). T02 coverage-honesty cases pending (M1-08). |
| CAP-07 | Pause honestly when X changes; library stays usable | M1 | T02 | M1-07, M1-08 | in progress | M1-07: unsupported X schema and control-only pages return `paused`, never ok/complete; job-level pause and UI pending. F0: ADR 0005 (passive capture; real-session check owner-run, Q6) |
| CAP-08 | Thread continuations: identity, order, flagged uncertainty | M1 | T02, T03 | M1-07 | in progress | M1-07: confirmed vs uncertain thread membership, other authors excluded, unavailable ancestry and gaps flagged (synthetic fixtures); end-to-end T02/T03 pending |
| CAP-09 | Original vs translation text kept separate | M1 | T03 | M1-07, M3-11 | in progress | M1-07: original text and translation kept as separate fields (synthetic fixtures); storage and citation attribution pending |
| ENR-01 | Linked posts/articles as separate sources; no recursive crawl | M1 | T15 | M1-11 | in progress | M1-11: link extraction, reuse of saved X posts and articles (including redirect-to-canonical), one fetch per destination (overlapping `enrich` calls on one connection share a single in-flight capture; coordination is per process), no crawl of fetched pages (`packages/core/src/links.ts`, `packages/store/src/linked.ts`); X posts not yet saved remain explicit gaps until the capture adapter handles them; not yet wired to capture jobs |
| ENR-02 | Link provenance fields; explicit gaps | M1 | T02, T03 | M1-11 | in progress | M1-11: `linked_fetch` stores original/final/canonical URL, redirect chain, title, observed time, extraction method, content hash; paywall, size, type, content-encoding, charset, extraction-limit, timeout, blocked and empty results persist as gaps (`packages/store/src/linked.ts`); an `extraction_capacity` gap (all extraction workers busy, page not examined) is transient and retried like a timeout, never treated as a permanent page outcome; a link that redirects to an existing source stores its fetched text as an immutable `source_version` keyed by (source, content hash) and records an observation, so every captured `linked_fetch` row joins a stored snapshot; cross-host canonical claims ignored; no search-snippet path |
| ENR-03 | SSRF/local-file blocking; size/time/type limits; sanitization | M1 | T02 | M1-11 | in progress | M1-11: IPv4/IPv6/mapped/NAT64/6to4/link-local/metadata blocking, DNS resolved once and connection pinned to the validated IP, every redirect hop re-screened, redirect bodies closed unread, one unpooled socket per hop, DNS resolution bounded by the overall timeout, `file:` and credentials rejected, size/timeout/content-type/redirect limits, non-identity `Content-Encoding` refused as a gap (never decompressed), bodies decoded by BOM, Content-Type charset or a parsed `<meta>` declaration with a fatal decoder (unsupported or invalid encodings are gaps, never replacement text), title/canonical/text taken from a parse5 HTML DOM so script, style, comment and attribute contents are not read as metadata, charset sniffing, decoding and DOM parsing of untrusted bodies run only in worker threads (`extract-isolated.ts`, `extract-worker.ts`): `captureLink`'s `timeoutMs` is one overall deadline covering fetch, queueing, worker startup and parse, and a worker still running at it is terminated and reported as a `timeout` gap while the caller's event loop keeps running; each worker has a heap limit (exhaustion is an `extraction_limit` gap); a pool bounds live workers and waiting requests (overflow is an `extraction_capacity` gap); worker startup failures and abrupt exits reject as defects and every outcome releases its slot only after the worker exits; iterative DOM traversal; a summed open-element-depth counter remains as defense in depth only (it does not see parser stack rescans such as unmatched end tags), text-only sanitized extraction (`packages/core/src/ssrf.ts`, `fetcher.ts`, `decode.ts`, `links.ts`, `extract-isolated.ts`); the synchronous `extractPage` and `decodeBody` helpers carry no resource bound of their own; tests use local servers and stubbed DNS; limits (5 MiB, 15 s overall, 2 workers, 32 waiting, 512 MiB worker heap) are PROPOSED defaults, not measured hardware guarantees, and termination latency adds to the deadline; port restriction not applied; not wired to capture or media jobs (the media store has no guarded fetch adapter). Security review in M5 (SEC-06/07) |
| MED-01 | Media preservation with hashes; resumable jobs | M1 | T01, T15 | M1-10 | in progress | M1-10: sha256 content-addressed blobs with reference counts, MIME type and size; Range-resumable downloads that validate `Content-Range` (safe-integer positions, including the exclusive end) against the representation length known from the response or saved earlier, before any file I/O, and resume only with a strong validator; a known length must be matched exactly before media is published; a 206 must carry the saved strong validator and one with an unknown representation length (`bytes a-b/*`) never completes; download jobs on the retained `acquire` lease where each execution attempt holds an exclusive claim token (also against a second call on the same lease) and writes only its own part file, taking over a predecessor's verified prefix by rename after a clean end or by copy after a lost lease, so stale async opens and writes cannot reach a new owner's part or a published blob; per-chunk lease fencing, short writes completed from `bytesWritten` and verified against the file size, an existing blob re-hashed before deduplication (a corrupt one is replaced), new blob reference counts include pre-existing (legacy) media rows, and blob/media commit through `JobStore.withLease`; failed entries keep a job `partial` and a direct `download` of a stopped (`failed`) entry returns `failed` without claiming or fetching (`packages/store/src/media.ts`, `media.test.ts`, store migration 5). Source relationships beyond `source_id`, acquisition-status UI and wiring to capture pending; the media store does no SSRF screening itself: network guarding (ENR-03) rests entirely on the required injected fetch, and no guarded `MediaFetch` adapter exists or is wired yet (M1-11 `guardedFetch` covers linked text pages only) |
| MED-02 | Opt-in OCR/transcription with provenance | M3 | T03, T15 | M3-05, M3-06 | not started | F0 resource behaviour test. F0: ADR 0004; resource test pending (blockers B5) |
| MED-03 | Derived text separate from original; user corrections as versions | M3 | T03 | M3-05, M3-06, M3-11 | not started |  |
| MED-04 | Media limit pauses downloads without eviction | M1 | T02 | M1-10 | in progress | M1-10: budget pause keeps resumable entries and evicts nothing, with each chunk reserved against one shared budget so concurrent jobs stay within it; free-space floor and ENOSPC from open, write, mkdir or rename pause all writes and keep recoverable partial state (`packages/store/src/media.ts`, `media.test.ts`). Disk-full is simulated through injected file operations; default budget (PROPOSED) is a helper, not yet wired to setup |
| MED-05 | Bounded concurrency/memory; no automatic model downloads | M1, M3 | T11 | M3-03, M3-05, M3-06, M4-01 | not started | F0 resource behaviour test. F0: ADR 0004; resource test pending (blockers B5) |
| SYN-01 | Plugin-free two-way sync; stable IDs; scoped access | M2 | T04, T15 | M2-04, M2-05 | in progress | M2-04: identity by frontmatter ID, then unique base-hash fallback; moves, duplicates, deletions, restore candidates (`packages/sync/src/identity.ts`). Scope, scan, and IO pending (M2-05). F0: ADR 0007 |
| SYN-02 | Immutable originals; separately attributed user content | M2 | T03, T04 | M2-04, M3-11 | in progress | M2-04: vault edits to the source section are reported as a user-authored version (`sourceEdit`, `source_edit` review record); the captured original is never changed. Multi-round source edits are kept against the immutable library rendering; a new capture version that would overwrite user source text is a conflict (`review.test.ts`, T04 source-section rounds). Attribution through search and citation pending (M3-11). F0: ADR 0007 |
| SYN-03 | Three-way merge; conflicts preserved for review | M2 | T04, T13 | M2-04, M2-06 | in progress | M2-04: section-aware diff3 body merge, per-key frontmatter merge, conflict records with all three variants (`packages/sync`, store migration 2). Rendered YAML is reparsed and structurally checked against intended merged values; anchor collateral mutations conflict with raw variants preserved (`review.test.ts`). Review UI pending (M2-06). F0: ADR 0007 |
| SYN-04 | Vault delete unlinks; trash suppresses re-import | M2 | T04, T07 | M2-05 | in progress | M1-12 (store side): trashing a source sets its `sync_binding` to `unlinked` with re-import suppressed (a stronger `deleted` suppression is kept), across restart; restore does not rebind (explicit restoration); purge keeps the binding with `deleted` suppression and drops library-side base content, hashes and review records (`packages/store/src/trash.ts`). Vault-side delete detection, watcher and explicit rebind pending M2-05. F0: ADR 0007 |
| SYN-05 | Watcher events as hints; atomic writes; no feedback loops; symlink policy | M2 | T04 | M2-05 | not started | F0: ADR 0007 |
| SYN-06 | Portable Markdown with versioned frontmatter | M2 | T04 | M2-04 | in progress | M2-04: `citspark.schema` version check (newer schema is a conflict, never rewritten; invalid mappings, sequences and null return safe diagnostics without object coercion), section markers, reversible marker escaping documented in ADR 0007. Written-file portability checks pending (M2-05). F0: ADR 0007 (frontmatter schema) |
| PLG-01 | Optional Obsidian companion plugin | M2, M4 | T06, T14, T15 | M2-09, M4-07 | not started | Research UI lands in M4. F0: ADR 0006 |
| PLG-02 | Plugin connection states; no independent DB or policy engine | M2 | T06, T14 | M2-09 | in progress | F0: ADR 0006. M1-05: hello negotiation with structured `incompatible` error. M1-06: core socket server enforces scopes and revocation for every client (T06 integration tests, ADR 0011); plugin and its UI pending (M2-09) |
| RET-01 | Unified search; exact-ID, keyword, semantic; visible mode | M3 | T10, T11, T12 | M3-02, M3-03 | not started | F0: ADR 0002, ADR 0003; keyword and vector cost measured (`docs/f0/benchmarks.md`) |
| RET-02 | Filters; trashed sources excluded at query time | M3 | T07 | M3-02 | not started | F0: FTS5 benchmark excludes trashed sources at query time |
| RET-03 | Exact excerpt/version/offset results; atomic index generations | M3 | T10, T11 | M3-01, M3-07 | not started | F0: ADR 0002 (index generations) |
| ORG-01 | User collections/tags/saved searches; AI suggestions need approval | M3 | T15 | M3-08 | not started | Ingestion independent of an LLM |
| GRF-01 | Interactive graph + accessible list; distinct edge origins | M3 | T13, T15 | M3-09, M3-10 | not started |  |
| GRF-02 | Bounded subgraphs; similarity is not a relationship | M3 | T11, T13 | M3-09 | not started |  |
| AI-01 | Quick + agentic answers; local and cloud providers | M4 | T10, T14 | M4-02, M4-03, M4-06 | not started | Tested capability matrices. F0: ADR 0004; `docs/f0/capability-matrix.md` |
| AI-02 | Evidence-only default; gaps; conflicting positions | M4 | T10, T12 | M4-03 | not started |  |
| AI-03 | Citations open exact archived passage; separate live link | M3, M4 | T03, T10, T13 | M3-07 | not started |  |
| AI-04 | Read-only library research; no live fetch/exec/recursion | M4 | T10 | M4-04 | not started |  |
| AI-05 | Enforced budgets, cancellation, explicit extension | M4 | T10, T13 | M4-04 | not started |  |
| AI-06 | Bounded action traces without chain-of-thought | M4 | T05, T10 | M4-04 | not started |  |
| AI-07 | Generated notes excluded from evidence by default | M4 | T03, T10 | M4-05 | not started |  |
| AI-08 | Schema/citation/quote validation; frozen eval set | M4 | T10, T12 | M4-03, M4-06 | not started |  |
| AI-09 | Jev optional experiment only | F0, M4 | T10 | M4-08 | not started | Not a launch dependency. F0: Optional (M4-08) |
| SEC-01 | Local archive/embeddings/OCR; per-library provider approval | M3, M4 | T05 | M3-03, M4-02 | not started |  |
| SEC-02 | Local-only enforcement across all derived artifacts before dispatch | M3, M4 | T05 | M3-04 | not started |  |
| SEC-03 | Local-only limitation explanation and explicit local rerun | M4 | T05 | M3-04 | not started |  |
| SEC-04 | OS credential storage; credentials excluded from logs/backups | M2 | T05, T08 | M1-06, M1-08, M2-03, M2-12 | in progress | F0: ADR 0006 (key storage), ADR 0008. M1-06: no shared secrets; core registry holds only client public keys; client static key wrapped by a non-extractable WebCrypto key (ADR 0011, unit tests). Desktop `safeStorage` and credential scanner pending |
| SEC-05 | No telemetry; redacted previewable support bundle | M5 | T05 | M2-03 | not started |  |
| SEC-06 | Escaping, CSV neutralization, path traversal, quotas, isolation | M1, M5 | T09 | M1-01, M1-09, M2-01, M2-12, M5-02, M5-04 | in progress | M1-01 adds CI dependency audit and license allowlist; signed updates in M5. CI maintenance: `actions/checkout` bumped to v7.0.1, still pinned to an immutable commit SHA. Dev dependency maintenance: a bounded pnpm override moves only `minimatch@>=7.0.0 <11.0.1` (transitive via typescript-eslint) to the patched 11.x line for GHSA-g3hv-75wg-m249; minimatch 3.x used by ESLint is unaffected. The temporary audit exception for GHSA-fc5q-39xc-vjpf (picomatch ReDoS, owner-approved, tracked in issue #21) was removed on 2026-11-22 because GitHub withdrew the advisory on 2026-11-18T15:38:56Z; it was withdrawn, not fixed or patched, and no patched picomatch release exists. `audit-exceptions.json` now has no exceptions. CI's ubuntu `Dependency audit` step runs `pnpm audit-gate` (`tools/audit-gate`), which runs a full (production, development and optional) and a production-only (production and optional) `pnpm audit --json` with the scope set explicitly on the command line so inherited `.npmrc`, environment or workspace settings cannot narrow it, prints both reports unchanged, and fails closed on every high or critical advisory in either report, a production-only report not covered by the full one, an unpinned pnpm, expiry, stale or malformed policy, network or parse errors, repeated findings and inconsistent exit codes or counts (`tools/audit-gate/src/*.test.ts`, `tools/audit-gate/test/*.test.ts`, including real-pnpm request-scope tests against a local synthetic registry). The exception history and the exposure review are kept in [dependency-audit-exceptions.md](../security/dependency-audit-exceptions.md). M1-09: an xarchive import source must be a regular `.json` file checked with `lstat` before opening (symlinks, FIFOs, devices and directories refused without blocking), opened with no-follow/non-blocking flags and re-checked by device and inode; size (default 128 MiB), record-count (500,000), text-length (200,000 characters) and nesting (64) limits reject oversized input; invalid UTF-8 is rejected; ZIP or other archives are never expanded (a real ZIP with a traversal entry and an 8 MiB bomb entry is rejected, `xarchive.test.ts`); handles and IDs are validated before URLs are built. CSV neutralization and renderer escaping pending |
| SEC-07 | Threat model | F0, M5 | T05, T06 | M1-06, M5-04 | in progress | Security review in M5. F0: ADR 0006 IPC threat analysis. M1-06: unauthorized local clients covered by the T06 suite (ADR 0011); full threat model in M5-04 |
| SEC-08 | No at-rest encryption promise; documented | M5 | T08 | M2-08, M5-05 | not started | Documentation check |
| DAT-01 | 100,000-post capacity target; incremental indexing | M1, M3 | T11 | M1-02, M3-01 | in progress | M1-02: schema and 19-digit ID round-trip (`packages/store`); capacity and incremental indexing pending. F0 100k-post search test. F0: 100k-post FTS5 benchmark on macOS (`docs/f0/benchmarks.md`); Windows run pending (B3) |
| DAT-02 | 8 GB RAM target for core; bounded batches | M1, M3 | T11 | M4-01 | not started | F0: Core search peak RSS 123 MB on M1 8 GB; Electron memory pending (B11) |
| DAT-03 | Recoverable trash; immediate exclusion; recapture suppression; purge | M1 | T07 | M1-12, M3-02 | in progress | M1-12: trash/restore; `active_source`/`active_version`/`active_chunk` views (migration 7) exclude trashed and purged sources at once; recapture suppressed for capture pages (canonical identity), linked enrichment (`suppressed` outcome, no fetch-to-store, no new version or edge) and media downloads (waiting and newly enqueued downloads held until restore); explicit purge removes media, derivations, chunks, versions, observations, membership, annotations, relationships (including ones evidenced by its versions), link references and unshared gap rows, partial downloads and unshared blobs (reference count validated against remaining media rows), refuses while a live lease holds a download, and queues file removals in `purge_file` for retry after a failed unlink or crash (`packages/store/src/trash.ts`). Search/AI query use pending M3-02; UI disclosure of vault and backup copies pending |
| DAT-04 | Unavailable-evidence reporting after deletion | M1, M3 | T07 | M1-12, M3-07 | in progress | M1-12: `TrashStore.status` reports `trashed`/`purged`/`unknown`; purge leaves a tombstone (identity only) so IDs and linked URLs resolve to it as unavailable, never to another source. Purge never touches vault files or backups. Citation UI in M3-07 |
| BKP-01 | Manual and scheduled backups; verification; restore | M2 | T08, T15 | M2-08 | not started | F0: ADR 0008 |
| BKP-02 | Password-encrypted backups with maintained AEAD | M2 | T08 | M2-08 | not started | F0 encryption format decision. F0: ADR 0008; `prototypes/backup-age`; scrypt accepted (Q3) |
| BKP-03 | Full portable backups; manifests; media-excluded disclosure | M2 | T08 | M2-08 | not started | F0: ADR 0008 (hashed manifest) |
| MIG-01 | Import native backups, owner vault, xarchive; dry-run | M1 | T09, T15 | M1-09, M2-02, M2-07, M5-03 | in progress | F0: xarchive = `sytelus/xarchive` (Q2). M1-09: xarchive importer (`packages/store/src/xarchive.ts`) with dry-run counts, mapping, duplicates, warnings, and conflicts; commit through `CaptureStore.commitPage` with method `import`; deterministic per-file job so a repeat is a no-op, and a page plan that depends only on the file so an interrupted import resumes even if other jobs stored content meanwhile; the weaker-content rule (empty or truncated text never adds a version over a fuller stored copy, account membership still recorded) is decided inside each commit transaction; unavailable status is carried to the observation; the retained lease is renewed with a fresh clock before every page and a cancel request stops at the next page boundary (CAP-03, CAP-04); unsupported schemas rejected. Tested against `sytelus/xarchive` 1.1.0 (`ae9d026`), schema 1 and 2, synthetic fixtures in `fixtures/xarchive/`. Folder assignments are reported, not stored; native backup and owner-vault importers pending |
| MIG-02 | Pre-migration backup; candidate indexes; no destructive generator | M2 | T08, T09 | M1-02, M2-07, M2-10, M3-01, M5-03 | in progress | M1-02: numbered transactional migrations and pre-migration backup hook; every recorded migration ID and name is validated, and a recorded gap (jobs-only databases at [1, 3]) receives the order-independent sync-core migration 2 exactly once after backup (`migrate.test.ts` upgrade matrix); M1-04 adds additive `capture-commit` as migration 4 after published 2 and 3; upgrades from fresh, [1], [1, 2], [1, 3] and [1, 2, 3] keep legacy repeated observations (capture de-duplication indexes capture rows only); M1-10 adds additive `media-store` as migration 5 (upgrades from every earlier state, legacy duplicate media rows kept while new duplicates are refused, the unmerged PR #9 preview that recorded it as 2 is refused by name); M1-11 adds additive `linked-sources` as migration 6 (the unmerged PR #13 preview that recorded it as 3 is refused by name); M1-12 adds additive `trash-purge` as migration 7 (the unmerged PR #16 preview that recorded it as 4 is refused by name); candidate indexes pending. Migration trials in M5 |
| ACC-01 | Keyboard, screen reader, contrast, reduced motion (WCAG 2.2 AA) | M5 | T13 | M2-02, M2-06, M3-02, M3-09, M5-01 | not started | Incremental from M2 onward |
| ACC-02 | Names, focus order, announcements, scalable text | M5 | T13 | M2-02, M5-01 | not started | Assistive-technology testing |
| LAN-01 | English UI/AI quality; Unicode preserved; documented limits | M5 | T10, T13 | M3-01, M5-05 | not started |  |

## M1-03 integration notes

- CAP-03/CAP-04: worker renew, checkpoint, and transition calls now require a retained
  `{ owner, generation }` lease, not just an owner string. `acquire` returns this token atomically
  (or null on exclusion), replacing its former boolean result. Dependent capture/media layers must
  retain that token rather than rereading the generation for delayed work.
- CAP-03/CAP-04: timed `JobStore` calls (`acquire`, `renew`, `checkpoint`, `transition`, `cancel`,
  `findExpired`) throw `RangeError` before any change unless time is a non-negative safe integer
  (epoch ms), TTL is a positive safe integer, and the computed expiry is a safe integer, so NaN
  clocks cannot bypass expiry and non-positive TTLs cannot open same-scope overlaps.
- MIG-02: existing databases, including unmarked ones that already have tables, require a
  successful recovery backup hook before pending migrations. `migrate` inspects existing state
  read-only; the hook completes before the first schema-changing statement, including creation of
  the `schema_migration` bookkeeping table, so a refused or failed backup leaves the database
  byte-identical. Only a truly empty database is initialised without a backup. Unknown or renamed
  recorded migrations, and gaps for migrations not declared order-independent, are refused before
  backup or SQL.
  The hook is synchronous; one that returns a Promise or other thenable (for example an un-awaited
  `db.backup()`) is rejected before any migration runs, so callers finish async backups first.
  A rejected native Promise is marked handled; a custom thenable's `then` is never called.
- Published migration numbers are stable and never renumbered: version 1 `initial-schema` (with
  its main-branch foreign-key constraints unchanged), version 2 `sync-core` (PR #18) and version 3
  `job-lease-generation`. The runner validates every recorded ID and name, not only the maximum.
  Version 2 is declared order-independent, so a jobs-only database recorded as [1, 3] receives it
  exactly once after backup ([1, 3] -> [1, 2, 3]); upgrades from [], [1], [1, 2], [1, 3] and
  [1, 2, 3] are covered by the `migrate.test.ts` upgrade matrix.

## M1-04 integration notes

- CAP-03: `CaptureStore.commitPage(jobId, lease, nowMs, page)` takes the `Lease` returned by
  `JobStore.acquire`, not an owner string. Callers retain that token; rebuilding it from
  `JobStore.get` would let a stale worker impersonate a newer acquisition. `null` is accepted only
  to acknowledge a page a `complete` job already committed.
- CAP-03: `JobStore.withLease(id, lease, nowMs, fn)` is the public boundary for consumers that must
  write atomically under a lease. It validates the clock (non-negative safe integer) and the
  owner, generation and expiry, then runs `fn` in the same IMMEDIATE transaction (or savepoint), so
  no other connection can take over between the check and the work. `assertLease` stays private.
  The callback is a trusted synchronous contract, enforced at run time (the type stays
  `(job) => T` so generic consumer wrappers keep compiling): an async function (any realm,
  including async generators) is refused with a TypeError before it is invoked, and any other
  callback that returns a Promise or thenable has its writes rolled back and is refused (a rejected
  native Promise is marked handled; a custom `then` is never called). Work a callback schedules for
  later (after an `await` in a bound or proxied async function, timers, callbacks) runs outside the
  transaction and is not fenced, so callbacks must not schedule database writes.
- MIG-02: capture bookkeeping is migration 4 (`capture-commit`). The unmerged preview numbered it 2;
  a database that recorded that preview is refused by name before backup or SQL.

## M1-09 integration notes

- CAP-03/MIG-01: `CapturePage.method` (`capture` default, `import`) and the optional
  `CaptureRecord.availability` and `CaptureRecord.retainFuller` fields are additive. Their values
  enter a page fingerprint only when they differ from the defaults, so fingerprints of pages already
  committed by capture adapters are unchanged. `CommitResult` adds `weakerSkipped`,
  `unavailableNoText` and `noContentSkipped` counts (zero for capture pages and replays).
- MIG-01/T09: text quality is compared by content (`isWeakerText`, exported from the package): a
  trailing `…` or `...` marks a truncation and is not content, so `abc...` is weaker than `abcd`.
  In-file repeats of one `tweet_id` keep the fuller text in either order; distinct texts are all
  kept as versions with an explicit `duplicate-distinct-versions` warning.
- MIG-01/Q37: availability is evidence independent of text quality. A weaker record adds an
  observation with its availability against the retained fuller version, with `evidence`
  `{"kind":"retained-fuller","incoming":"empty"|"truncated","textCaptured":false}`. An unavailable
  record with no text and no stored text records the identity, account membership and an
  unavailable observation of an explicit empty snapshot (`completeness` `none`, evidence
  `{"kind":"unavailable-no-text","textCaptured":false}`); an available record with no text and no
  stored copy still writes nothing (`available-no-text` warning).
- MIG-01/Q37: in-file deduplication of one `tweet_id` decides text versions only. The status of every
  dropped repeat (identical, truncated or textless) is attached to the kept text it belongs to as
  `CaptureRecord.alsoReported` (one report per availability, keeping the one that carried the most
  text; additive, fingerprinted only when present, so seven-field capture fingerprints are
  unchanged). In the commit, all reports for `retainFuller` records are merged into the one
  observation per job and version (migration 4's unique index is unchanged; no new migration):
  a commutative, idempotent join, so file order, page boundaries, crash-and-retry and re-read passes
  give the same row. One availability keeps the single-report evidence shapes above; both give
  `availability` `conflicting` with evidence
  `{"kind":"conflicting-availability","chronology":"unknown","textCaptured":…,"reports":[{"availability","text":"captured"|"truncated"|"empty"|"none"}]}`.
  The parse warns `conflicting-availability`. Live capture records keep insert-or-ignore.
- Limit for M2 retry flow: a cancelled import of a byte-identical file stays blocked (deterministic
  job ID); a distinct retry attempt is a product decision, not implemented here.
- CAP-03: `commitXArchive` takes `clock` (epoch ms, default `Date.now`) instead of a fixed `nowMs`,
  retains the `Lease` from `JobStore.acquire`, and renews it before every page.

## M1-10 integration notes

- MED-01/CAP-03: `MediaStore.runJob` retains the `Lease` returned by `JobStore.acquire` and passes
  that token to every renew, checkpoint, transition and `withLease` call; `download(id, ctx)` takes
  the caller's retained lease and throws `LeaseError` for a stale or forged token before any network
  or file work. The clock is injected (`now`) and must advance; the lease renews after a third of
  its TTL, and a lost lease stops the transfer (`lease_lost`) without committing.
- MED-01: each execution attempt claims its entry by (job, lease generation) plus an exclusive
  token in a lease-checked transaction and writes only its own part file (`tmp/<id>.<token>.part`),
  so no two attempts, including two calls on one retained lease, share a file; a claim held by
  another live attempt returns `claimed`. A successor takes over a cleanly ended attempt's prefix
  by rename and a lost attempt's recorded prefix by copy, then unlinks the old path, so a stale
  open or write can reach only an orphaned file. The fetch boundary is required and redirects are never followed by the media store.
- MIG-02: the media store is migration 5 after published 1-4; numbers are never reused.
- Test hygiene: the one `guardrails-disable-line` in `media.test.ts` marks a false positive on the
  loopback fixture's partial write of fixed synthetic PNG bytes (not Express, no echo, no HTML). No
  file, rule or global scanner exclusion is added.

## M1-11 integration notes

- MIG-02: linked sources are migration 6 (`linked-sources`) after published 1-5; numbers are never
  reused. The unmerged PR #13 preview numbered it 3; a database that recorded that preview is
  refused by name before backup or SQL. Upgrades from every earlier recorded state, including
  media-store 5, are covered by the `migrate.test.ts` upgrade matrix.
- ENR-03: untrusted page bodies are decoded and parsed only in `ExtractionPool` worker threads. The
  overall `captureLink` deadline includes queueing and worker startup; `extraction_capacity` is a
  transient gap. A compiled-package test runs the emitted `extract-worker.js` with type stripping
  disabled. The earlier summed-depth parse counter is defense in depth, not a comprehensive bound.

## M1-12 integration notes

- MIG-02: trash and purge are migration 7 (`trash-purge`) after published 1-5 (media-store 5 landed
  with M1-10) and linked-sources 6 (M1-11, merged in #13); numbers are never reused. The unmerged PR #16 preview
  numbered capture-commit 2, media-store 3 and trash-purge 4; a database that recorded any of those
  names is refused by name before backup or SQL. Upgrades from every earlier recorded state, a
  rolled-back failed migration 7, and idempotent re-runs are covered by `migrate.test.ts`.
- DAT-03: `TrashStore.purge(sourceId, nowMs)` throws `PurgeBusyError` while one of the source's
  downloads has a running media attempt (an unreleased `claim_token` under a live lease);
  `emptyTrash` reports such sources as `busy`. A cleanly ended attempt does not block purge.
- DAT-03: in-flight async file work of a worker whose lease already expired is not stoppable from
  the store. Under the attempt-isolated media model its late open or write reaches only its own
  `tmp/<id>.<token>.part`, which purge queues and removes and the attempt removes again when it
  ends; its database commits are refused by the lease and token fence and by the
  `media_purged_source` trigger. Its rename into `blobs/` either fails (purge already removed the
  part) or leaves a file no `blob` or `media` row names, which `retryPendingFiles` (run by every
  trash, purge and `emptyTrash`; callers should also run it at startup) removes. Blob files are
  never removed while any media attempt is running under a live lease, so another source's
  attempt that has just published or verified the same bytes keeps them; the removal stays queued
  (`trash.test.ts`, "purge against attempt-isolated media downloads", named paths asserted).
- DAT-03: trash stops every entry without a running attempt, clears its claim (so a job cannot
  retry its own failure of a trashed source) and, for an attempt that never ended, queues its part
  file for removal and restarts the entry from zero instead of letting a resume take over a file a
  stale handle may still write. Restore re-queues only entries trash stopped.
- DAT-03: purged downloads remain as `failed`/`source_purged` rows (claim token and part file
  cleared) so their ids are never reused and re-enqueueing is a no-op. Partial files are matched by
  download id under `tmp/` (`<id>.part` and `<id>.<token>.part`) and by the recorded part file.
  Blob rows and files of the purged source are removed when no remaining `media` row names the
  content; media rows win over `blob.ref_count` drift in both directions.
- ENR-01: `LinkedSourceStore.enrich` returns `suppressed` for a trashed or purged destination.
- MIG-01/DAT-03 (integration with M1-09): `CommitResult.suppressed` counts records of trashed or
  purged sources that the commit skips. The xarchive preview classifies them the same way
  (`counts.suppressed`, not in `toCommit`, no `new-version` conflict, `trashed-or-purged` warning)
  and the import receipt reports `suppressed`, so dry-run and receipt match the commit
  (`trash.test.ts`, "previews and receipts suppressed xarchive records honestly").
- ENR-01/DAT-03: every linked persistence write (captured, reused, joined in-flight capture, gap,
  known gap and suppressed-destination provenance) runs in one IMMEDIATE transaction that re-checks
  the parent first. A parent trashed or purged while its enrichment was in flight gets `suppressed`
  with a null `sourceId` and nothing stored (no article, version, link reference, gap or edge), so
  purge stays final. A capture shared with a live parent is not cancelled; only the live parent is
  attached (`trash.test.ts`, "late linked persistence after the parent is purged").
- DAT-03: `emptyTrash` retries every queued file removal, including those of sources purged
  earlier, even when nothing is in trash, and its `filesPending` counts every removal still queued
  after the call, not only those of the sources it purged. `blobsRemoved` is logical removal, not
  proof of erasure. Covered with a real unlink denial (non-writable blob directory, then permission
  restored and database reopened) on POSIX; skipped on Windows and as root, where directory modes do
  not deny unlink (`trash.test.ts`, "purge integrity").

## M1-08 integration notes

- CAP-03/CAP-04: `capture.stop` sends every outcome, `cancelled` included, through
  `JobStore.transition` with the held lease, which validates owner, generation and expiry before any
  write. A holder whose expired lease was reclaimed gets `lease_lost` and can no longer mark its
  successor's job `cancel_requested` (`capture-ipc.test.ts`). Review fix: a cancel from a holder
  whose lease merely expired (same owner and generation, nobody took over) is honoured (the job is
  cancelled) and the next start creates a new job instead of resuming it; a `cancel_requested` job
  whose holder went silent is finished as cancelled at the next start. Other outcomes from an
  expired holder stay `lease_lost`. A same-client `capture.start` over its own expired lease
  reclaims cleanly, or answers `job_busy` if another client holds it; never a raw `LeaseError`.
- CAP-03/CAP-05 (review D1): the 120 s lease TTL used to expire during legitimate pacing holds (a
  600 s Retry-After, or three 429 backoffs). New `capture.renew` (protocol, `CaptureRenewPayload`)
  extends the lease of the exact holder, pass and generation only; a superseded holder, a wrong
  pass or an already expired lease gets `lease_lost` and extends nothing, and a heartbeat also
  learns of a cancel requested in Citspark. The extension's `CaptureRun` sends it every
  `leaseHeartbeatMs` (30 s release, 500 ms test pacing) from `begin()` until the run ends; only
  `lease_lost` ends the run, a desktop outage is retried (`capture-ipc.test.ts` with a fake clock,
  `apps/extension/test/run.test.ts`).
- ADR 0006/SEC-04 (review D4): `installNativeHost`/`uninstallNativeHost` never follow a symlink,
  write via temp file and rename, replace or remove a manifest, launcher, config or Windows key only
  when its content proves Citspark wrote it, and throw `NativeHostInstallError` (typed `code`) for
  an unsupported browser or platform. Windows writes the per-browser HKCU key through an injected
  `reg.exe` runner (moved from the live kit). **Real Windows execution is unverified locally**; the
  CI Windows runner runs the unit tests with the injected runner only.
- Known limitation (informational): a well-formed but lower gap tally in a job checkpoint is
  undetectable by the core; planting one requires tampering with the library database itself, which
  is outside the threat model of this layer.
- CAP-04/CAP-06 (T02): a pass that continues must find its own well-formed gap tally in the job
  checkpoint. An unparseable, non-object, missing, malformed or other-pass tally throws
  `CheckpointCorruptError` (nothing of the page is written; the record is kept); the core fails the
  job (`checkpoint_corrupt`, needs attention) and the extension shows a failed run. It never resets
  the known gaps to 0 or completes. A fresh pass from the top recounts its own gaps
  (`capture-t02.test.ts`, `capture-ipc.test.ts`, `apps/extension/test/run.test.ts`).
- `@citspark/protocol` adds error code `checkpoint_corrupt`.
- CAP-01 to CAP-07, SEC-04, Q20, Q21 (manual), Q22, Q31, Q40, B8 (owner live kit):
  `pnpm live-kit:setup|launch|desktop|evidence|teardown` (`apps/extension/scripts/live-kit/`) and the owner
  checklist `docs/m1-08/live-acceptance.md`. The kit builds the extension, makes a dedicated browser profile
  outside the repo, installs the native host (exact extension origin) for Chrome or Edge, and exports a
  credential-free evidence JSON gated by the T02 credential scanner. Unit tests cover path logic against a
  temporary HOME and a synthetic exporter and canary test. **The owner live run (full pass, interrupt, resume,
  Chrome and Edge) has NOT been done**; no requirement status changes because of the kit. Windows registration
  and Linux paths are unit-tested only, never run.

## Status maintenance notes

- README status: the milestone row for M1 reads `in progress`, matching the merged M1-01 to M1-07 and M1-09 to M1-11
  layers (and M1-12 once this PR lands) and the requirement rows above (CAP-01 to CAP-04, CAP-06 to
  CAP-09, DAT-01, MED-01, MED-04, MIG-01, MIG-02).
  M1 is partial, not complete: M1-08 is pending. README status mirrors this matrix and records no test counts.
- M1-09: README and the M1 milestone row list the xarchive importer library (dry-run preview, shared commit path,
  receipt, replay, availability evidence) as merged. This claims no import UI and no validation against a private or
  real archive; native backup and owner-vault imports stay pending.
- M1-11 (merged in #13) and M1-12 (this PR, once merged): README and the M1 milestone row add the linked-source and trash/purge
  foundations as library-only code. This claims no app or UI, no live-network validation, no production fetch wiring (capture or
  media jobs), and no automatic startup cleanup: queued file removals are retried only when a caller runs
  `retryPendingFiles` (or trash, purge or `emptyTrash`, which call it).

## Acceptance tests

| ID | Name | Milestone gate | Plan layers | Status | F0 evidence |
| --- | --- | --- | --- | --- | --- |
| T01 | Capture replay | M1 | M1-04 | implemented | M1-04: 18 child-process kill cases (mid-page, before-commit, after-commit × pages 0, 6, 11 × fresh or same-pass resume) in `packages/store/src/t01.test.ts`; see `docs/testing/t01-capture-replay.md`. Verified locally on macOS; CI matrix run pending. F0 prototype: `prototypes/capture-commit` |
| T02 | Coverage honesty | M1 | M1-08 | in progress | M1-08 (synthetic only): `apps/extension/test/t02/t02.e2e.ts` runs the built MV3 extension in Playwright Chromium against mock X with the real native host, IPC server and store (17 cases: full pass, pause/resume, cursor loop, auth, 429, schema, disk full, partial thread, tombstone, account switch, cancel, budget, desktop loss, credential scan). Store part in `packages/store/src/capture-t02.test.ts`. Owner live full-pass and resume run and Chrome/Edge validation pending (kit and checklist in `docs/m1-08/live-acceptance.md`; not yet run) |
| T03 | Attribution | M1, M3 | M1-07, M3-11, M4-05 | in progress | ADR 0010 |
| T04 | Sync | M2 | M2-04, M2-05 | in progress | M2-04: seeded fast-check property tests (`packages/sync/src/t04.property.test.ts`): random concurrent edit sequences never lose user text; same-key metadata changes conflict. Filesystem harness pending (M2-05) |
| T05 | Privacy | M3, M4 | M3-04 | not started | — |
| T06 | Pairing | M2 | M1-06, M2-09 | in progress | ADR 0006, ADR 0011. M1-06: socket, channel, pairing (including a socket squatter claiming `pair.ok`), registry-owned replay ledger and Windows pipe DACL suite in `packages/core/src/ipc/t06.test.ts`; the DACL check bounds its PowerShell child (pipe connect 5 s < child 20 s < test 30 s) and logs each stage it reached; plugin in M2-09 |
| T07 | Deletion | M1, M2 | M1-12, M3-02 | in progress | M1-12 store part in `packages/store/src/trash.test.ts` (synthetic): immediate exclusion, restart, recapture suppression (capture, linked, media), sync unlink and suppression across restart, purge with shared blobs and linked references, end-to-end trash/recapture/purge. Search and sync-IO parts pending M3-02, M2-05 |
| T08 | Backup | M2 | M2-08 | not started | F0 prototype: 5 passing tests in `prototypes/backup-age` |
| T09 | Import | M1 | M1-09, M5-03 | in progress | M1-09: xarchive part in `packages/store/src/xarchive.test.ts`; native backup and vault parts pending |
| T10 | AI | M4 | M4-06, M5-07 | not started | — |
| T11 | Performance | M3 | M3-02, M3-03 | not started | F0 keyword and vector benchmarks on M1 8 GB; Windows reference run pending (Q5, B3) |
| T12 | Quality | M4 | M4-06, M5-07 | not started | ADR 0010; frozen set pending (B4) |
| T13 | Accessibility | M5 | M2-06, M5-01 | not started | — |
| T14 | Clean install | M5 | M5-02 | not started | Packaging pending (B1) |
| T15 | End-to-end | M5 | M5-06 | not started | — |

## Milestones

| ID | Name | Scope | Status | Evidence |
| --- | --- | --- | --- | --- |
| M0 | Feasibility | Measured prototypes, licence inventory, architecture decisions, capability matrix; owner-reviewed plan | complete | [ADRs 0001–0010](../adr/README.md), [F0 results](../f0/README.md), [owner decisions](../f0/owner-decisions.md); plan approved 2026-11-16 |
| M1 | Data foundation | Archive, versioning, jobs, capture, import, media, recoverable storage (preview only) | in progress | M1-01 to M1-12 (M1-01 to M1-07 and M1-09 to M1-11 merged, M1-12 once this PR lands; M1-08 pending) |
| M2 | Desktop and vault | Packaged apps, pairing, two-way sync, conflicts, plugin controls, backups, restore | in progress | M2-01 to M2-12 (M2-04 sync core in progress) |
| M3 | Knowledge layer | Search, OCR/transcripts, organization, graph/list, exact citations, privacy filtering | not started | M3-01 to M3-11 |
| M4 | Intelligence | Local runtime, cloud adapters, quick answers, bounded research, plugin research UI, frozen evaluation | not started | M4-01 to M4-08 |
| M5 | Release hardening | Accessibility, compatibility, migration trials, security review, docs, demo, clean-machine acceptance | not started | M5-01 to M5-07 |

## Decision ledger

| ID | Governing requirements | Milestone | Plan layers | Status |
| --- | --- | --- | --- | --- |
| Q01 | All of CAP/RET/AI | M1-M5 | whole plan | not started |
| Q02 | SYN-01, PLG-01 | M2 | whole plan | not started |
| Q03 | SYN-01..SYN-03 | M2 | M2-04 | in progress |
| Q04 | SYN-02 | M2 | M2-04, M3-11 (via SYN-02) | in progress |
| Q05 | SYN-04 | M2 | M2-05 (via SYN-04) | not started |
| Q06 | SYN-03 | M2 | M2-04 | in progress |
| Q07 | SYN-01 | M2 | M2-05 | not started |
| Q08 | SYN-01 | M2 | M2-05 | not started |
| Q09 | T14 | M5 | M2-01, M5-02 | not started |
| Q10 | SEC-01, DAT-01 | M1 | M1-02 | in progress |
| Q11 | AI-01, SEC-01 | M4 | M4-02 | not started |
| Q12 | AI-01, AI-04 | M4 | M4-04 | not started |
| Q13 | AI-02 | M4 | M4-03 | not started |
| Q14 | AI-01, AI-07 | M4 | whole plan | not started |
| Q15 | CAP-01 | M1 | M1-07, M2-12 | in progress |
| Q16 | ENR-01 | M1 | M1-11 | in progress |
| Q17 | CAP-08 | M1 | M1-07 | in progress |
| Q18 | MED-01, MED-02 | M1, M3 | M3-05, M3-06 | not started |
| Q19 | MED-03 | M3 | M3-05 | not started |
| Q20 | T14 | M5 | M1-08, M5-02 | not started |
| Q21 | CAP-04 | M1 | M1-08, M2-11 | not started |
| Q22 | CAP-02 | M1 | M1-08 | not started |
| Q23 | T14 | M2, M5 | M2-01 | not started |
| Q24 | AI-01, MED-05 | M4 | M4-01 | not started |
| Q25 | SEC-01, SEC-02 | M3, M4 | M3-03 | not started |
| Q26 | DAT-01 | M1, M3 | M1-02 | in progress |
| Q27 | DAT-02 | M1, M3 | M4-01 | not started |
| Q28 | MED-04 | M1 | M1-10 | in progress |
| Q29 | BKP-01 | M2 | M2-08 | not started |
| Q30 | BKP-02 | M2 | M2-08 | not started |
| Q31 | CAP-07 | M1 | M1-08 | not started |
| Q32 | LAN-01 | M5 | M5-05 | not started |
| Q33 | Licensing / OSS hygiene | L0, M1-01 | M1-01 | in progress (M1-01 adds the CI license allowlist check) |
| Q34 | F0 | F0 | F0 (ADRs 0001–0010) | verified |
| Q35 | Release policy | All | whole plan | not started |
| Q36 | SEC-05 | M5 | M2-03 | not started |
| Q37 | MIG-01 | M1 | M1-09, M2-07, M5-03 | in progress |
| Q38 | MIG-01 | M1 | M1-09 | in progress |
| Q39 | Section 7 identity rules | M1 | M1-02 | in progress |
| Q40 | Scope: read-only X | M1 | M1-08 | not started |
| Q41 | AI-02 | M4 | M4-03 | not started |
| Q42 | AI-07 | M4 | M4-05 | not started |
| Q43 | AI-03 | M3, M4 | M3-07 | not started |
| Q44 | ACC-01, ACC-02 | M5 | M5-01 | not started |
| Q45 | ORG-01 | M3 | M3-08 | not started |
| Q46 | GRF-01, GRF-02 | M3 | M3-09 | not started |
| Q47 | GRF-01 | M3 | M3-10 | not started |
| Q48 | AI-04 | M4 | M4-04 | not started |
| Q49 | AI-05 | M4 | M4-04 | not started |
| Q50 | DAT-03 | M1 | M1-12 | in progress |
| Q51 | SYN-04 | M2 | M1-12, M2-05 | in progress |
| Q52 | SYN-01, PLG-01 | M2, M4 | M2-09 | not started |
| Q53 | PLG-01 | M4 | M4-07 | not started |
| Q54 | PLG-02, Section 4 | M2 | M1-06, M2-09 | in progress |
| Q55 | Section 4, MIG-02 | M2 | M1-05, M2-10 | in progress |
| Q56 | SEC-01, SEC-02 | M3, M4 | M3-04 | not started |
| Q57 | SEC-03 | M4 | M3-04 | not started |
| Q58 | AI-01 | M4 | M4-02 | not started |
| Q59 | AI-09 | F0 | M4-08 | not started |
| Q60 | AI-01 | M4 | M4-06 | not started |
| Q61 | Release policy | M5 | whole plan | not started |

## Implementation notes

- **§14 API contract (M1-05, `packages/protocol`)**: zod schemas, length-prefixed framing with oversize rejection and linear-time reassembly of fragmented frames, `hello` negotiation, request IDs with an idempotency ledger, structured errors and stream sequence numbers are implemented with unit tests. The ledger never forgets an accepted request ID; when full it rejects new IDs with `idempotency_exhausted` instead of evicting, so a late retry cannot repeat a mutation. Frame limits (1 MB toward the extension, 8 MB toward the core) remain PROPOSED.
- **M1-06 IPC and pairing (`packages/ipc`, `packages/core/src/ipc`, `packages/native-host`)**: Noise XX pairing confirmed in both directions (a 6-digit code the client shows and the user types into the desktop, then one the desktop shows and the user types into the client), Noise IK per connection, encrypted records, scopes, revocation, a Unix socket or named pipe server and a native messaging relay (ADR 0011). The T06 suite runs in `packages/core/src/ipc/t06.test.ts`. The client registry is in memory until M2; desktop key storage and pairing UI are M2; extension UI is M1-08.
