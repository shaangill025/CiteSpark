# Traceability matrix

Maps every requirement in [the specification](citspark-spec-v1.0.md) to a milestone and acceptance tests.
Milestone and test assignments are a **proposed** planning aid (L0); the spec's section 15/16 text is authoritative.
Update `Status` in the PR that changes it. Allowed values: `not started`, `in progress`, `implemented`, `verified`.

## Requirements

| ID | Summary | Milestone | Acceptance tests | Status | Notes |
| --- | --- | --- | --- | --- | --- |
| CAP-01 | Versioned capture adapters; audited collector evaluation | F0, M1 | T01, T02 | in progress | M1-07: versioned `CaptureAdapter` in `packages/capture-x` (passive parse, ADR 0005); F0 licence/dependency audit of xarchive and twitter-web-exporter; real-session capture unvalidated |
| CAP-02 | String platform IDs; account-bound membership; account-switch pause | M1 | T01, T02 | in progress | M1-02: string IDs, account-scoped membership schema (`packages/store`); account-switch pause pending |
| CAP-03 | Atomic record+cursor commit; idempotent replay; lease | M1 | T01 | not started |  |
| CAP-04 | Pause/resume/cancel and failure outcomes; loop, schema, disk detection | M1 | T02, T15 | not started |  |
| CAP-05 | Retry-After, bounded backoff, no auth bypass | M1 | T02 | not started |  |
| CAP-06 | Honest 'complete' definition and termination evidence | M1 | T02 | not started |  |
| CAP-07 | Pause honestly when X changes; library stays usable | M1 | T02 | in progress | M1-07: unsupported X schema returns `paused`, never ok/complete; job-level pause and UI pending |
| CAP-08 | Thread continuations: identity, order, flagged uncertainty | M1 | T02, T03 | in progress | M1-07: confirmed vs uncertain thread membership, other authors excluded, gaps flagged (synthetic fixtures); end-to-end T02/T03 pending |
| CAP-09 | Original vs translation text kept separate | M1 | T03 | in progress | M1-07: original text and translation kept as separate fields (synthetic fixtures); storage and citation attribution pending |
| ENR-01 | Linked posts/articles as separate sources; no recursive crawl | M1 | T15 | not started |  |
| ENR-02 | Link provenance fields; explicit gaps | M1 | T02, T03 | not started |  |
| ENR-03 | SSRF/local-file blocking; size/time/type limits; sanitization | M1 | T02 | not started | Security review in M5 (SEC-06/07) |
| MED-01 | Media preservation with hashes; resumable jobs | M1 | T01, T15 | not started |  |
| MED-02 | Opt-in OCR/transcription with provenance | M3 | T03, T15 | not started | F0 resource behaviour test |
| MED-03 | Derived text separate from original; user corrections as versions | M3 | T03 | not started |  |
| MED-04 | Media limit pauses downloads without eviction | M1 | T02 | not started |  |
| MED-05 | Bounded concurrency/memory; no automatic model downloads | M1, M3 | T11 | not started | F0 resource behaviour test |
| SYN-01 | Plugin-free two-way sync; stable IDs; scoped access | M2 | T04, T15 | not started |  |
| SYN-02 | Immutable originals; separately attributed user content | M2 | T03, T04 | not started |  |
| SYN-03 | Three-way merge; conflicts preserved for review | M2 | T04, T13 | not started |  |
| SYN-04 | Vault delete unlinks; trash suppresses re-import | M2 | T04, T07 | not started |  |
| SYN-05 | Watcher events as hints; atomic writes; no feedback loops; symlink policy | M2 | T04 | not started |  |
| SYN-06 | Portable Markdown with versioned frontmatter | M2 | T04 | not started |  |
| PLG-01 | Optional Obsidian companion plugin | M2, M4 | T06, T14, T15 | not started | Research UI lands in M4 |
| PLG-02 | Plugin connection states; no independent DB or policy engine | M2 | T06, T14 | not started |  |
| RET-01 | Unified search; exact-ID, keyword, semantic; visible mode | M3 | T10, T11, T12 | not started |  |
| RET-02 | Filters; trashed sources excluded at query time | M3 | T07 | not started |  |
| RET-03 | Exact excerpt/version/offset results; atomic index generations | M3 | T10, T11 | not started |  |
| ORG-01 | User collections/tags/saved searches; AI suggestions need approval | M3 | T15 | not started | Ingestion independent of an LLM |
| GRF-01 | Interactive graph + accessible list; distinct edge origins | M3 | T13, T15 | not started |  |
| GRF-02 | Bounded subgraphs; similarity is not a relationship | M3 | T11, T13 | not started |  |
| AI-01 | Quick + agentic answers; local and cloud providers | M4 | T10, T14 | not started | Tested capability matrices |
| AI-02 | Evidence-only default; gaps; conflicting positions | M4 | T10, T12 | not started |  |
| AI-03 | Citations open exact archived passage; separate live link | M3, M4 | T03, T10, T13 | not started |  |
| AI-04 | Read-only library research; no live fetch/exec/recursion | M4 | T10 | not started |  |
| AI-05 | Enforced budgets, cancellation, explicit extension | M4 | T10, T13 | not started |  |
| AI-06 | Bounded action traces without chain-of-thought | M4 | T05, T10 | not started |  |
| AI-07 | Generated notes excluded from evidence by default | M4 | T03, T10 | not started |  |
| AI-08 | Schema/citation/quote validation; frozen eval set | M4 | T10, T12 | not started |  |
| AI-09 | Jev optional experiment only | F0, M4 | T10 | not started | Not a launch dependency |
| SEC-01 | Local archive/embeddings/OCR; per-library provider approval | M3, M4 | T05 | not started |  |
| SEC-02 | Local-only enforcement across all derived artifacts before dispatch | M3, M4 | T05 | not started |  |
| SEC-03 | Local-only limitation explanation and explicit local rerun | M4 | T05 | not started |  |
| SEC-04 | OS credential storage; credentials excluded from logs/backups | M2 | T05, T08 | not started |  |
| SEC-05 | No telemetry; redacted previewable support bundle | M5 | T05 | not started |  |
| SEC-06 | Escaping, CSV neutralization, path traversal, quotas, isolation | M1, M5 | T09 | not started | M1-01 adds CI dependency audit and license allowlist; signed updates in M5 |
| SEC-07 | Threat model | F0, M5 | T05, T06 | not started | Security review in M5 |
| SEC-08 | No at-rest encryption promise; documented | M5 | T08 | not started | Documentation check |
| DAT-01 | 100,000-post capacity target; incremental indexing | M1, M3 | T11 | in progress | M1-02: schema and 19-digit ID round-trip (`packages/store`); capacity and incremental indexing pending. F0 100k-post search test |
| DAT-02 | 8 GB RAM target for core; bounded batches | M1, M3 | T11 | not started |  |
| DAT-03 | Recoverable trash; immediate exclusion; recapture suppression; purge | M1 | T07 | not started |  |
| DAT-04 | Unavailable-evidence reporting after deletion | M1, M3 | T07 | not started |  |
| BKP-01 | Manual and scheduled backups; verification; restore | M2 | T08, T15 | not started |  |
| BKP-02 | Password-encrypted backups with maintained AEAD | M2 | T08 | not started | F0 encryption format decision |
| BKP-03 | Full portable backups; manifests; media-excluded disclosure | M2 | T08 | not started |  |
| MIG-01 | Import native backups, owner vault, xarchive; dry-run | M1 | T09, T15 | not started |  |
| MIG-02 | Pre-migration backup; candidate indexes; no destructive generator | M2 | T08, T09 | in progress | M1-02: numbered transactional migrations and pre-migration backup hook; candidate indexes pending. Migration trials in M5 |
| ACC-01 | Keyboard, screen reader, contrast, reduced motion (WCAG 2.2 AA) | M5 | T13 | not started | Incremental from M2 onward |
| ACC-02 | Names, focus order, announcements, scalable text | M5 | T13 | not started | Assistive-technology testing |
| LAN-01 | English UI/AI quality; Unicode preserved; documented limits | M5 | T10, T13 | not started |  |

## Acceptance tests

| ID | Name | Milestone gate | Status |
| --- | --- | --- | --- |
| T01 | Capture replay | M1 | not started |
| T02 | Coverage honesty | M1 | not started |
| T03 | Attribution | M1, M3 | in progress |
| T04 | Sync | M2 | not started |
| T05 | Privacy | M3, M4 | not started |
| T06 | Pairing | M2 | not started |
| T07 | Deletion | M1, M2 | not started |
| T08 | Backup | M2 | not started |
| T09 | Import | M1 | not started |
| T10 | AI | M4 | not started |
| T11 | Performance | M3 | not started |
| T12 | Quality | M4 | not started |
| T13 | Accessibility | M5 | not started |
| T14 | Clean install | M5 | not started |
| T15 | End-to-end | M5 | not started |

## Milestones

| ID | Name | Scope | Status |
| --- | --- | --- | --- |
| M0 | Feasibility | Measured prototypes, licence inventory, architecture decisions, capability matrix; owner-reviewed plan | not started |
| M1 | Data foundation | Archive, versioning, jobs, capture, import, media, recoverable storage (preview only) | not started |
| M2 | Desktop and vault | Packaged apps, pairing, two-way sync, conflicts, plugin controls, backups, restore | not started |
| M3 | Knowledge layer | Search, OCR/transcripts, organization, graph/list, exact citations, privacy filtering | not started |
| M4 | Intelligence | Local runtime, cloud adapters, quick answers, bounded research, plugin research UI, frozen evaluation | not started |
| M5 | Release hardening | Accessibility, compatibility, migration trials, security review, docs, demo, clean-machine acceptance | not started |

## Decision ledger

| ID | Governing requirements | Milestone | Status |
| --- | --- | --- | --- |
| Q01 | All of CAP/RET/AI | M1-M5 | not started |
| Q02 | SYN-01, PLG-01 | M2 | not started |
| Q03 | SYN-01..SYN-03 | M2 | not started |
| Q04 | SYN-02 | M2 | not started |
| Q05 | SYN-04 | M2 | not started |
| Q06 | SYN-03 | M2 | not started |
| Q07 | SYN-01 | M2 | not started |
| Q08 | SYN-01 | M2 | not started |
| Q09 | T14 | M5 | not started |
| Q10 | SEC-01, DAT-01 | M1 | in progress |
| Q11 | AI-01, SEC-01 | M4 | not started |
| Q12 | AI-01, AI-04 | M4 | not started |
| Q13 | AI-02 | M4 | not started |
| Q14 | AI-01, AI-07 | M4 | not started |
| Q15 | CAP-01 | M1 | in progress |
| Q16 | ENR-01 | M1 | not started |
| Q17 | CAP-08 | M1 | in progress |
| Q18 | MED-01, MED-02 | M1, M3 | not started |
| Q19 | MED-03 | M3 | not started |
| Q20 | T14 | M5 | not started |
| Q21 | CAP-04 | M1 | not started |
| Q22 | CAP-02 | M1 | not started |
| Q23 | T14 | M2, M5 | not started |
| Q24 | AI-01, MED-05 | M4 | not started |
| Q25 | SEC-01, SEC-02 | M3, M4 | not started |
| Q26 | DAT-01 | M1, M3 | in progress |
| Q27 | DAT-02 | M1, M3 | not started |
| Q28 | MED-04 | M1 | not started |
| Q29 | BKP-01 | M2 | not started |
| Q30 | BKP-02 | M2 | not started |
| Q31 | CAP-07 | M1 | not started |
| Q32 | LAN-01 | M5 | not started |
| Q33 | Licensing / OSS hygiene | L0, M1-01 | in progress (M1-01 adds the CI license allowlist check) |
| Q34 | F0 | F0 | not started |
| Q35 | Release policy | All | not started |
| Q36 | SEC-05 | M5 | not started |
| Q37 | MIG-01 | M1 | not started |
| Q38 | MIG-01 | M1 | not started |
| Q39 | Section 7 identity rules | M1 | in progress |
| Q40 | Scope: read-only X | M1 | not started |
| Q41 | AI-02 | M4 | not started |
| Q42 | AI-07 | M4 | not started |
| Q43 | AI-03 | M3, M4 | not started |
| Q44 | ACC-01, ACC-02 | M5 | not started |
| Q45 | ORG-01 | M3 | not started |
| Q46 | GRF-01, GRF-02 | M3 | not started |
| Q47 | GRF-01 | M3 | not started |
| Q48 | AI-04 | M4 | not started |
| Q49 | AI-05 | M4 | not started |
| Q50 | DAT-03 | M1 | not started |
| Q51 | SYN-04 | M2 | not started |
| Q52 | SYN-01, PLG-01 | M2, M4 | not started |
| Q53 | PLG-01 | M4 | not started |
| Q54 | PLG-02, Section 4 | M2 | not started |
| Q55 | Section 4, MIG-02 | M2 | not started |
| Q56 | SEC-01, SEC-02 | M3, M4 | not started |
| Q57 | SEC-03 | M4 | not started |
| Q58 | AI-01 | M4 | not started |
| Q59 | AI-09 | F0 | not started |
| Q60 | AI-01 | M4 | not started |
| Q61 | Release policy | M5 | not started |
