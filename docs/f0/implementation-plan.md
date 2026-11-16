# Implementation plan: M1 to M5

Status: **awaiting owner review.** M0 exits when the owner approves this plan (§16).

## How delivery works

- Work ships as a stack of small pull requests. One layer = one branch = one pull request, stacked on the layer it depends on.
- Each layer lists the requirements it implements and the acceptance tests that must pass in CI before review. A layer is done when its tests pass and the PR is reviewed and merged by the owner.
- Layers with no dependency between them can run in parallel. The **After** column lists hard dependencies only.
- Release-blocking suites from §15 (T01, T04, T05, T06, T08, credential disclosure) run on every OS in CI from the layer that introduces them onward.
- ADRs are in `docs/adr/`. A layer that has to deviate from an ADR writes a superseding ADR in the same PR.
- Fixtures are synthetic. No real X data or vault content enters the repository.

## Change from the spec's milestone grouping

Extension-to-desktop IPC and pairing (ADR 0006) move from M2 into M1, because capture cannot reach the canonical store without it. Plugin pairing, the paired-clients screen, and the plugin itself stay in M2. No requirement is removed. **Owner review requested.**

## M1: data foundation (preview status only)

Goal: the canonical archive, jobs, capture, import, media preservation, and recoverable storage, driven from a dev harness and the extension. No packaged desktop UI yet.

| Layer | Scope | Requirements | Acceptance tests | After |
|---|---|---|---|---|
| M1-01 scaffold | pnpm workspace, TypeScript project references, Vitest, ESLint, CI on 4 OSes, license allowlist check, `fixtures/` with a synthetic-only README | Q33, SEC-06 (dependency scanning) | Clean clone installs, builds, lints, and tests on macOS, Windows, Linux. License check fails on a planted GPL dependency. | |
| M1-02 store schema | `packages/store`: §7 tables, string platform IDs, numbered migrations in transactions, pre-migration backup hook | DAT-01, CAP-02, MIG-02, Q10, Q26, Q39 | Migrations up from empty; failed migration rolls back; identical text under different IDs stays distinct; 19-digit IDs round-trip exactly. | M1-01 |
| M1-03 jobs and leases | job table, state machine (pause, resume, cancel, auth-required, rate-limited, partial, failed, complete), lease acquire, renew, expiry, durable checkpoints | CAP-03, CAP-04, CAP-06 | Property test: every state transition sequence ends in a valid state; overlapping owners rejected; cancel keeps committed records. | M1-02 |
| M1-04 capture commit | page + cursor atomic commit, replay idempotency across a fresh pass with new cursors (ADR 0005), cursor-mismatch and skip rejection, account binding (port of the F0 prototype) | CAP-02, CAP-03, CAP-06 | **T01** on every CI OS (SIGKILL / TerminateProcess at 3 points × 3 pages). Mutation check documented. | M1-03 |
| M1-05 protocol | `packages/protocol`: zod schemas, framing, `hello` version negotiation, request IDs, structured errors, stream sequence numbers | §14 API contract, Q55 | Incompatible versions produce a structured error; oversized frames rejected; reconnect never repeats a mutation. | M1-01 |
| M1-06 IPC and pairing | core socket server (Unix socket and named pipe), native messaging host relaying ciphertext, Noise XX pairing confirmed by a 6-digit code, Noise KK per connection with every frame encrypted, scopes, revocation | Q54, SEC-04, SEC-07 | **T06**: unpaired, revoked, wrong origin, wrong scope, replayed handshake, relayed or injected frames, and incompatible clients all fail without reading or writing data. Named pipe DACL checked on the Windows runner. | M1-05 |
| M1-07 X adapter | `packages/capture-x`: versioned adapter, parsers for bookmarks, bookmark folders, likes, threads, quotes, translations; synthetic fixtures | CAP-01, CAP-07, CAP-08, CAP-09, Q15, Q17 | **T03** (capture part): root, quote, translation, thread continuation stay distinct. Unsupported schema → paused, not complete. | M1-02 |
| M1-08 extension | MV3 extension, passive capture of X's own responses with automated scrolling (ADR 0005), pacer, account detection, page handoff over native messaging, mock-X Playwright harness | CAP-01 to CAP-05, CAP-07, SEC-04, Q20, Q21 (manual part), Q22, Q31, Q40 | **T02** against mock X: cursor loop, auth failure, 429 with Retry-After, unsupported schema, disk full, partial thread never end as complete. Credential scanner finds no cookie or token in any stored output. Chrome and Edge. Before merge, the owner runs one capture against their own account to confirm the passive model works (blockers B8). | M1-04, M1-06, M1-07 |
| M1-09 xarchive import | importer with dry-run counts, mapping, duplicates, warnings, conflicts; preview then commit through the same commit path | MIG-01, Q37, Q38, SEC-06 | **T09** (xarchive part): repeated import idempotent; malicious paths and archive bombs rejected; fuller captures not replaced by weaker imports. | M1-04 |
| M1-10 media store | content-addressed blobs, resumable download jobs, media budget and disk-safety pause, reference counts | MED-01, MED-04, Q28 | Budget reached → new media paused, text continues, nothing evicted; interrupted download resumes; disk-full simulation pauses all writes safely. | M1-03 |
| M1-11 linked sources | link extraction, reuse of saved sources, web fetcher with SSRF guards, metadata, explicit gaps | ENR-01, ENR-02, ENR-03, Q16 | Private-network, loopback, and `file:` targets blocked including after redirects and DNS changes; size, timeout, content-type limits enforced; no recursive crawl. | M1-10 |
| M1-12 trash and purge | recoverable trash, recapture suppression, explicit purge with reference counting | DAT-03, DAT-04, Q50 | **T07** (store part): trashed source excluded from queries at once, survives restart, purge removes unshared derived data and keeps shared blobs. | M1-04, M1-10 |

Parallel groups: {M1-05 → M1-06} alongside {M1-02 → M1-03 → M1-04}; M1-07 after M1-02; M1-10 after M1-03.

## M2: desktop and vault

| Layer | Scope | Requirements | Acceptance tests | After |
|---|---|---|---|---|
| M2-01 Electron shell | Electron app hosting the core in a utility process, hardened renderer, electron-builder installers for all OSes, unsigned or signed per owner decision | Q09, Q23, SEC-06 | Installers build in CI; app starts on clean VMs with no developer tools; idle memory recorded on the 8 GB reference machine. | M1-06 |
| M2-02 core screens | onboarding, library browser, capture control and status, import preview | CAP-04, MIG-01, ACC-01, ACC-02 | Playwright flows with axe-core clean; keyboard-only onboarding and import. | M2-01 |
| M2-03 credentials and diagnostics | `safeStorage` for keys, redacted previewable support bundle, local health checks, network-use disclosure screen | SEC-04, SEC-05, Q36 | Credential scanner over diagnostics, logs, exports finds nothing; no network calls without user action (asserted by a recording proxy). | M2-01 |
| M2-04 sync engine core | section-aware diff3 merge, frontmatter per-key merge, identity by ID then hash, conflict records | SYN-01, SYN-02, SYN-03, SYN-06, Q03 to Q06 | **T04** property tests: random concurrent edit sequences never lose user text; same-key metadata changes conflict. | M1-02 |
| M2-05 sync IO | scope selection, reconcile loop, watcher hints, atomic writes with hash re-check, feedback-loop guard, symlink policy, unlink and suppression | SYN-01, SYN-04, SYN-05, Q07, Q08, Q51 | **T04** filesystem harness: rename, move, delete, delete versus library edit (conflict), recreate of an unlinked note (review, not auto-rebind), included user notes never body-edited, watcher loss, external sync rewrite, interrupted write, on every OS. | M2-04 |
| M2-06 conflict review | conflict list and side-by-side resolution, accessible | SYN-03, ACC-01 | Keyboard and screen-reader resolution of a conflict (T13 subset). | M2-05, M2-02 |
| M2-07 owner vault migration | dry run of the existing owner vault: IDs to assign, files to touch, provenance mapping, backup first | MIG-01, MIG-02, Q37 | Dry run on a synthetic vault shaped like the owner's makes no writes; apply after backup; rollback restores. | M2-05, M2-08 |
| M2-08 backup and restore | tar + manifest, age encryption, schedules, retention, destination checks, restore into fresh install that acts only after the decrypt stream ends cleanly | BKP-01, BKP-02, BKP-03, SEC-08, Q29, Q30 | **T08** in full: encrypted and plaintext restore with hash, annotation, policy, relationship, citation checks; wrong password; corruption and truncation leave the existing library untouched; missing media; missing destination. | M1-12, M2-01, M2-03 |
| M2-09 Obsidian plugin skeleton | desktop-only plugin, pairing, status states, paired-clients screen in desktop with revoke | PLG-01 (status), PLG-02, Q52, Q54 | **T06** for the plugin; disconnected, unpaired, incompatible, desktop-not-running shown; plugin creates no database. | M1-06, M2-01 |
| M2-10 compatibility checks | version gates on clients and schema; unsafe operations blocked, unaffected features still work | Q55, MIG-02 | Old plugin against new desktop gets a clear blocked state, search still works; migration runs only after backup. | M2-09 |
| M2-11 scheduled capture | opt-in schedules when desktop and authenticated browser are present | Q21, CAP-04, CAP-05 | Schedule skips with a reason when the browser is closed or signed out; respects pacing and budget. | M1-08, M2-02 |
| M2-12 exports | export of collections, search results, and partial capture results to Markdown, CSV, and JSON; per-export privacy filtering | SEC-04, SEC-06, CAP-04, Q15, §14 exports | CSV cells starting with `=`, `+`, `-`, `@`, tab, or carriage return are neutralized; HTML and Markdown in captured text is escaped in every renderer and export; credential scanner finds nothing in exports; local-only material excluded unless the user includes it. No PDF export (Q15 requires explicit owner approval first). | M1-12, M2-02 |

## M3: knowledge layer

| Layer | Scope | Requirements | Acceptance tests | After |
|---|---|---|---|---|
| M3-01 chunking and FTS generations | chunker with exact offsets, external-content FTS5 per generation, atomic switch and rollback, optional trigram | RET-03, DAT-01, LAN-01, MIG-02 | Generation switch is atomic under crash; rollback restores previous results; offsets map back to exact text. | M1-04 |
| M3-02 search API and screen | exact ID, keyword, filters, trash and policy filtering at query time, retrieval mode shown | RET-01, RET-02, DAT-03, ACC-01 | **T11** keyword on the reference machines through IPC; trashed and excluded material never returned (T07 search part). | M3-01, M2-02 |
| M3-03 embeddings and hybrid | local embedding model via sidecar, int8 vectors per generation, RRF fusion, fallback disclosure | RET-01, SEC-01, MED-05, Q25 | **T11** hybrid p95; model change creates a new generation; no download during a query. | M3-01, M4-01 |
| M3-04 privacy policy engine | local-only scopes, provenance inheritance through chunks, OCR, transcripts, summaries, caches, graph text | SEC-02, SEC-03, Q56, Q57 | **T05** with mock providers: zero protected content in requests, traces, diagnostics. | M3-01 |
| M3-05 OCR | opt-in tesseract.js worker, regions, machine-generated labels, corrections as user versions | MED-02, MED-03, MED-05, Q18, Q19 | Synthetic images with known text; peak memory recorded; output labeled and separate from source text. | M1-10, M4-01 |
| M3-06 transcription | opt-in whisper.cpp sidecar, Chromium audio decode, time-range segments | MED-02, MED-03, MED-05, Q18 | Synthetic speech fixtures; peak memory and throughput recorded; cancel frees memory. | M1-10, M4-01 |
| M3-07 viewer and citations | exact archived version view at passage, image region, or timestamp; live link; evidence-type labels | AI-03, RET-03, DAT-04, Q43 | Citation opens exact offsets; deleted evidence reports unavailable instead of resolving elsewhere. | M3-02 |
| M3-08 organization | collections, tags, filters, saved searches, batch approval for suggestions | ORG-01, Q45 | Ingestion works with no model loaded; suggestions never applied without approval. | M3-02 |
| M3-09 graph and list | bounded subgraphs, filters, captured/user/inferred edges distinct, accessible list equivalent | GRF-01, GRF-02, Q46, ACC-01 | Never renders more than the bound; list view reaches every node keyboard-only. | M3-07 |
| M3-10 relationship approvals | AI-proposed edges as proposals, approval keeps inferred status | GRF-01, Q47 | Approved inference still labeled inferred in graph, citations, and exports. | M3-09 |
| M3-11 attribution end-to-end | root, quote, user edit, translation, OCR, transcript, AI note distinguished through import, sync, search, citation | SYN-02, MED-03, CAP-09 | **T03** for root, quote, user edit, translation, OCR, and transcript. AI notes are added to the same suite in M4-05. | M3-07, M2-05, M3-05, M3-06 |

## M4: intelligence

| Layer | Scope | Requirements | Acceptance tests | After |
|---|---|---|---|---|
| M4-01 worker runtime | sidecar manager, resource governor, model manager with license display, hash-verified downloads | MED-05, DAT-02, Q24, Q27 | Kill and restart sidecars; governor refuses over-budget jobs; downloads verified; never during a query. | M2-01 |
| M4-02 provider adapters | OpenAI, Anthropic, Gemini, OpenAI-compatible; capability probes; per-library and per-provider approval | AI-01, SEC-01, Q11, Q58 | Mock-server contract tests for each; unsupported capabilities disabled; no fallback to another provider. | M3-04 |
| M4-03 quick answers | retrieval, evidence-only answer, response validation (schema, citation membership, exact quotes, versions, policy) | AI-01, AI-02, AI-08, Q13, Q41 | Invalid outputs rejected or reduced to evidence; conflicting sources shown with dates. | M4-02, M3-03, M3-07 |
| M4-04 bounded research | read-only tools, tool-call/time/token/context budgets, cancel, partial findings, traces | AI-04, AI-05, AI-06, Q12, Q48, Q49 | Stops at each budget with findings and gaps; no tool can write or fetch the web; trace saved and privacy-filtered. | M4-03 |
| M4-05 generated notes | AI notes searchable, excluded from evidence, resolved to underlying sources | AI-07, Q42 | A generated claim never appears as primary evidence in an answer. **T03** in full: the M3-11 suite extended with AI notes. | M4-03, M3-11 |
| M4-06 frozen evaluation | frozen set, harness for fixed and agentic modes, local and cloud configurations, independent review | AI-01, AI-08, Q60 | **T10** and **T12** reports; the PROPOSED local configurations pass or the published requirements change. | M4-04 |
| M4-07 plugin research UI | in-vault search, cited chat, bounded research through the desktop | PLG-01, Q53 | Plugin uses desktop budgets and policies; no separate policy engine. | M4-04, M2-09 |
| M4-08 Jev experiment (optional) | feasibility only, same privacy and consent rules | AI-09, Q59 | Everything works with it disabled. | M4-04 |

## M5: release hardening

| Layer | Scope | Requirements | Acceptance tests | After |
|---|---|---|---|---|
| M5-01 accessibility audit | WCAG 2.2 AA review, screen readers on each OS, fixes | ACC-01, ACC-02, Q44 | **T13** in full. | M4-07 |
| M5-02 compatibility and signing | full matrix, signed builds per owner decision, update channel | Q09, Q20, SEC-06 | **T14** on clean machines. | M5-01 |
| M5-03 migration trials | owner vault and xarchive trials, native backup round trips | MIG-01, MIG-02, Q37 | **T09** in full; owner-run trial report. | M2-07, M1-09 |
| M5-04 security review | threat model document, review of IPC, importers, renderers, fetchers, prompt injection | SEC-06, SEC-07 | Findings fixed or accepted by the owner; release-blocking suites green. | M4-04 |
| M5-05 docs and demo | user docs, limitations, synthetic demo library | SEC-08, LAN-01, Q32, §16 | Docs state backup-vs-library encryption and tokenizer limits; demo uses only synthetic data. | M5-02 |
| M5-06 clean-machine E2E | full workflow on each OS | all | **T15** on each platform. Then owner acceptance (Q61). | M5-02, M5-03, M5-04, M5-05, M5-07 |
| M5-07 release integration | merge point for every required layer: confirms that all M1 to M4 layers except the optional M4-08 are merged, and that the M4-06 evaluation passed or the published requirements changed | all | Dependency audit of the stack; T10 and T12 reports from M4-06 attached; every release-blocking suite green on all OSes. | M1-08, M1-11, M2-06, M2-10, M2-11, M2-12, M3-06, M3-08, M3-10, M4-05, M4-06, M4-07 |

## Traceability check

Every requirement ID in §5 to §13 and every test T01 to T15 appears in at least one layer above. Q01, Q02, Q14, Q34, Q35, and Q61 are scope and release constraints that apply to the whole plan rather than one layer: no layer may narrow scope, Obsidian integration ships with the non-Obsidian product, structured learning stays deferred, the stack was chosen through F0, and previews are labeled. The L0 traceability document (`docs/spec/traceability.md`) maps requirements to tests; this plan maps them to layers.

## Risks

- **X changes during development**: parsing lives only in M1-07, tested with fixtures. CAP-07 pauses capture honestly.
- **Local models fail T10 on 8 GB**: publish a higher local-AI requirement (DAT-02 allows it), keep core features on 8 GB.
- **Electron memory**: measured in M2-01 before UI work grows.
- **Signing costs**: owner decision before beta (blockers B2).
