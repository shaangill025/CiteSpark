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
| ENR-01 | Linked posts/articles as separate sources; no recursive crawl | M1 | T15 | M1-11 | not started |  |
| ENR-02 | Link provenance fields; explicit gaps | M1 | T02, T03 | M1-11 | not started |  |
| ENR-03 | SSRF/local-file blocking; size/time/type limits; sanitization | M1 | T02 | M1-11 | not started | Security review in M5 (SEC-06/07) |
| MED-01 | Media preservation with hashes; resumable jobs | M1 | T01, T15 | M1-10 | in progress | M1-10: sha256 content-addressed blobs with reference counts, MIME type and size; Range-resumable downloads that validate `Content-Range` (safe-integer positions, including the exclusive end) against the representation length known from the response or saved earlier, before any file I/O, and resume only with a strong validator; a known length must be matched exactly before media is published; a 206 must carry the saved strong validator and one with an unknown representation length (`bytes a-b/*`) never completes; download jobs on the retained `acquire` lease where each execution attempt holds an exclusive claim token (also against a second call on the same lease) and writes only its own part file, taking over a predecessor's verified prefix by rename after a clean end or by copy after a lost lease, so stale async opens and writes cannot reach a new owner's part or a published blob; per-chunk lease fencing, short writes completed from `bytesWritten` and verified against the file size, an existing blob re-hashed before deduplication (a corrupt one is replaced), new blob reference counts include pre-existing (legacy) media rows, and blob/media commit through `JobStore.withLease`; failed entries keep a job `partial` (`packages/store/src/media.ts`, `media.test.ts`, store migration 5). Source relationships beyond `source_id`, acquisition-status UI and wiring to capture pending. No production `MediaFetch` is wired yet: the store only requires an injected fetcher and refuses redirects; the ENR-03 network guard (private-network, loopback, DNS-rebinding and redirect validation) is not implemented and remains an integration gate for M1-11, so this row does not claim SSRF protection |
| MED-02 | Opt-in OCR/transcription with provenance | M3 | T03, T15 | M3-05, M3-06 | not started | F0 resource behaviour test. F0: ADR 0004; resource test pending (blockers B5) |
| MED-03 | Derived text separate from original; user corrections as versions | M3 | T03 | M3-05, M3-06, M3-11 | not started |  |
| MED-04 | Media limit pauses downloads without eviction | M1 | T02 | M1-10 | in progress | M1-10: budget pause keeps resumable entries and evicts nothing, with each chunk reserved against one shared budget so concurrent jobs stay within it; free-space floor and ENOSPC from open, write, mkdir or rename pause all writes and keep recoverable partial state (`packages/store/src/media.ts`, `media.test.ts`). Disk-full is simulated through injected file operations; default budget (PROPOSED) is a helper, not yet wired to setup |
| MED-05 | Bounded concurrency/memory; no automatic model downloads | M1, M3 | T11 | M3-03, M3-05, M3-06, M4-01 | not started | F0 resource behaviour test. F0: ADR 0004; resource test pending (blockers B5) |
| SYN-01 | Plugin-free two-way sync; stable IDs; scoped access | M2 | T04, T15 | M2-04, M2-05 | in progress | M2-04: identity by frontmatter ID, then unique base-hash fallback; moves, duplicates, deletions, restore candidates (`packages/sync/src/identity.ts`). Scope, scan, and IO pending (M2-05). F0: ADR 0007 |
| SYN-02 | Immutable originals; separately attributed user content | M2 | T03, T04 | M2-04, M3-11 | in progress | M2-04: vault edits to the source section are reported as a user-authored version (`sourceEdit`, `source_edit` review record); the captured original is never changed. Multi-round source edits are kept against the immutable library rendering; a new capture version that would overwrite user source text is a conflict (`review.test.ts`, T04 source-section rounds). Attribution through search and citation pending (M3-11). F0: ADR 0007 |
| SYN-03 | Three-way merge; conflicts preserved for review | M2 | T04, T13 | M2-04, M2-06 | in progress | M2-04: section-aware diff3 body merge, per-key frontmatter merge, conflict records with all three variants (`packages/sync`, store migration 2). Rendered YAML is reparsed and structurally checked against intended merged values; anchor collateral mutations conflict with raw variants preserved (`review.test.ts`). Review UI pending (M2-06). F0: ADR 0007 |
| SYN-04 | Vault delete unlinks; trash suppresses re-import | M2 | T04, T07 | M2-05 | not started | F0: ADR 0007 |
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
| SEC-06 | Escaping, CSV neutralization, path traversal, quotas, isolation | M1, M5 | T09 | M1-01, M1-09, M2-01, M2-12, M5-02, M5-04 | not started | M1-01 adds CI dependency audit and license allowlist; signed updates in M5. CI maintenance: `actions/checkout` bumped to v7.0.1, still pinned to an immutable commit SHA |
| SEC-07 | Threat model | F0, M5 | T05, T06 | M1-06, M5-04 | in progress | Security review in M5. F0: ADR 0006 IPC threat analysis. M1-06: unauthorized local clients covered by the T06 suite (ADR 0011); full threat model in M5-04 |
| SEC-08 | No at-rest encryption promise; documented | M5 | T08 | M2-08, M5-05 | not started | Documentation check |
| DAT-01 | 100,000-post capacity target; incremental indexing | M1, M3 | T11 | M1-02, M3-01 | in progress | M1-02: schema and 19-digit ID round-trip (`packages/store`); capacity and incremental indexing pending. F0 100k-post search test. F0: 100k-post FTS5 benchmark on macOS (`docs/f0/benchmarks.md`); Windows run pending (B3) |
| DAT-02 | 8 GB RAM target for core; bounded batches | M1, M3 | T11 | M4-01 | not started | F0: Core search peak RSS 123 MB on M1 8 GB; Electron memory pending (B11) |
| DAT-03 | Recoverable trash; immediate exclusion; recapture suppression; purge | M1 | T07 | M1-12, M3-02 | not started |  |
| DAT-04 | Unavailable-evidence reporting after deletion | M1, M3 | T07 | M1-12, M3-07 | not started |  |
| BKP-01 | Manual and scheduled backups; verification; restore | M2 | T08, T15 | M2-08 | not started | F0: ADR 0008 |
| BKP-02 | Password-encrypted backups with maintained AEAD | M2 | T08 | M2-08 | not started | F0 encryption format decision. F0: ADR 0008; `prototypes/backup-age`; scrypt accepted (Q3) |
| BKP-03 | Full portable backups; manifests; media-excluded disclosure | M2 | T08 | M2-08 | not started | F0: ADR 0008 (hashed manifest) |
| MIG-01 | Import native backups, owner vault, xarchive; dry-run | M1 | T09, T15 | M1-09, M2-02, M2-07, M5-03 | not started | F0: xarchive = `sytelus/xarchive` (Q2); version pinning in M1-09 |
| MIG-02 | Pre-migration backup; candidate indexes; no destructive generator | M2 | T08, T09 | M1-02, M2-07, M2-10, M3-01, M5-03 | in progress | M1-02: numbered transactional migrations and pre-migration backup hook; every recorded migration ID and name is validated, and a recorded gap (jobs-only databases at [1, 3]) receives the order-independent sync-core migration 2 exactly once after backup (`migrate.test.ts` upgrade matrix); M1-04 adds additive `capture-commit` as migration 4 after published 2 and 3; upgrades from fresh, [1], [1, 2], [1, 3] and [1, 2, 3] keep legacy repeated observations (capture de-duplication indexes capture rows only); M1-10 adds additive `media-store` as migration 5 (upgrades from every earlier state, legacy duplicate media rows kept while new duplicates are refused, the unmerged PR #9 preview that recorded it as 2 is refused by name); candidate indexes pending. Migration trials in M5 |
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

## Acceptance tests

| ID | Name | Milestone gate | Plan layers | Status | F0 evidence |
| --- | --- | --- | --- | --- | --- |
| T01 | Capture replay | M1 | M1-04 | implemented | M1-04: 18 child-process kill cases (mid-page, before-commit, after-commit × pages 0, 6, 11 × fresh or same-pass resume) in `packages/store/src/t01.test.ts`; see `docs/testing/t01-capture-replay.md`. Verified locally on macOS; CI matrix run pending. F0 prototype: `prototypes/capture-commit` |
| T02 | Coverage honesty | M1 | M1-08 | not started | — |
| T03 | Attribution | M1, M3 | M1-07, M3-11, M4-05 | in progress | ADR 0010 |
| T04 | Sync | M2 | M2-04, M2-05 | in progress | M2-04: seeded fast-check property tests (`packages/sync/src/t04.property.test.ts`): random concurrent edit sequences never lose user text; same-key metadata changes conflict. Filesystem harness pending (M2-05) |
| T05 | Privacy | M3, M4 | M3-04 | not started | — |
| T06 | Pairing | M2 | M1-06, M2-09 | in progress | ADR 0006, ADR 0011. M1-06: socket, channel, pairing (including a socket squatter claiming `pair.ok`), registry-owned replay ledger and Windows pipe DACL suite in `packages/core/src/ipc/t06.test.ts`; plugin in M2-09 |
| T07 | Deletion | M1, M2 | M1-12, M3-02 | not started | — |
| T08 | Backup | M2 | M2-08 | not started | F0 prototype: 5 passing tests in `prototypes/backup-age` |
| T09 | Import | M1 | M1-09, M5-03 | not started | — |
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
| M1 | Data foundation | Archive, versioning, jobs, capture, import, media, recoverable storage (preview only) | not started | M1-01 to M1-12 |
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
| Q16 | ENR-01 | M1 | M1-11 | not started |
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
| Q37 | MIG-01 | M1 | M1-09, M2-07, M5-03 | not started |
| Q38 | MIG-01 | M1 | M1-09 | not started |
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
| Q50 | DAT-03 | M1 | M1-12 | not started |
| Q51 | SYN-04 | M2 | M2-05 | not started |
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
