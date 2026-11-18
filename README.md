# Citspark

> Preserve sources. Retrieve evidence. Learn with traceable answers.

Citspark is a planned local-first desktop application (macOS, Windows, Linux) that preserves your saved X posts and
linked sources, makes them searchable, and answers questions from them with exact, verifiable citations. It includes
two-way Obsidian synchronization and an optional Obsidian companion plugin.

## Status: foundation implementation in progress, no usable application yet

Citspark is **not a usable application yet**. There is no packaged desktop app, browser extension, or Obsidian
plugin, and no feature can be used end to end. Planned work ships as clearly labeled alpha/beta previews; version 1.0
waits until every required capability passes its acceptance gates.

The owner approved the F0 architecture decisions and the [implementation plan](docs/f0/implementation-plan.md) as
amended ([owner decisions](docs/f0/owner-decisions.md)). Decisions that depend on later validation stay open in the
layers named there, for example the owner-run real capture before M1-08 merges and the reference-hardware runs.

Foundation libraries merged on `main`, each with unit or property tests on synthetic data only:

- `packages/store`: canonical schema with string platform IDs, numbered transactional migrations with a
  pre-migration backup hook, job state machine with fenced leases and durable checkpoints, and atomic capture page
  commit with idempotent replay (M1-02 to M1-04; T01 in `packages/store/src/t01.test.ts`), and an xarchive import
  library: bounded file reading, a dry-run preview, a commit through the shared capture path with an import receipt
  and idempotent replay, and availability evidence for unavailable or repeated posts (M1-09; T09 xarchive part in
  `packages/store/src/xarchive.test.ts`). It has no import UI and is tested on synthetic fixtures only, not on a
  real or private archive
- `packages/protocol`: message schemas, framing, version negotiation, and request-ID idempotency (M1-05)
- `packages/ipc`, `packages/core/src/ipc`, `packages/native-host`: Noise pairing and encrypted local IPC with scopes
  and revocation ([ADR 0011](docs/adr/0011-noise-ipc-implementation.md); T06 core suite in
  `packages/core/src/ipc/t06.test.ts`) (M1-06)
- `packages/capture-x`: versioned X response parser tested against synthetic fixtures only; not validated against
  live X (M1-07)
- `packages/store` media library: content-addressed media blobs with hashes, resumable Range downloads on fenced job
  leases, and a storage limit that pauses downloads without eviction (M1-10; migration 5). The store does no network
  screening itself and no production media fetcher is wired: the M1-11 guarded fetch covers linked text pages only,
  with no media adapter yet; wiring to capture and acquisition-status UI remain pending
- `packages/core` and `packages/store` linked-source library (M1-11; migration 6): link extraction, reuse of saved
  sources, a guarded fetcher for linked text pages (private-network, loopback, `file:`, DNS-pinning and per-hop
  redirect checks; size, overall-time, content-type and redirect limits), charset decoding and DOM text extraction in
  bounded, terminable worker threads, and linked-source provenance with explicit gaps. Its limits are PROPOSED
  defaults rather than measured guarantees; tested with local servers and stubbed DNS only; no live-network
  validation, and not wired to capture or media jobs
- `packages/store` trash and purge library: recoverable trash with immediate exclusion through active views,
  recapture suppression for capture pages, linked enrichment and media downloads, sync unlink with re-import
  suppression, and purge that keeps an identity-only tombstone (M1-12; migration 7; T07 store part in
  `packages/store/src/trash.test.ts`). Purge and empty trash commit row removal and queue file removals; a file is
  physically erased only when a queued removal later succeeds. Failed removals stay queued and are retried only when a
  caller runs `retryPendingFiles` (trash, purge and empty trash call it); nothing runs at startup automatically, and
  purge does not touch vault files or backups
- `packages/sync`: sync merge core (note identity, three-way merge, conflict records) with no vault file access yet
  (M2-04; T04 property tests in `packages/sync/src/t04.property.test.ts`)

These are libraries only: no desktop app or UI uses them yet, and none is validated against live services.
Not yet merged on main: the browser extension and live capture (M1-08), native backup and vault imports, production
fetch wiring for linked sources and media, the desktop app, vault file sync, backups, saved-library search and
retrieval, citations, and AI answers. M1 is not complete. See the [traceability matrix](docs/spec/traceability.md) for per-requirement status.

| Milestone | Scope | Status |
| --- | --- | --- |
| F0/M0 | Feasibility prototypes, license inventory, architecture decisions | complete (plan approved; follow-up gates open) |
| M1 | Data foundation: archive, capture, import, media, recoverable storage | in progress (M1-01 to M1-07 and M1-09 to M1-12 merged; M1-08 pending) |
| M2 | Desktop app, pairing, two-way vault sync, backups | in progress (M2-04 sync core only) |
| M3 | Search, OCR/transcripts, organization, graph, exact citations | not started |
| M4 | Local and cloud answers, bounded research, plugin research UI | not started |
| M5 | Accessibility, compatibility, security review, docs, release | not started |

## Documents

- [Specification v1.0](docs/spec/citspark-spec-v1.0.md): authoritative in-repo transcription of the owner-approved PDF
- [Traceability matrix](docs/spec/traceability.md): requirement, milestone, acceptance test, status
- [Contributing](CONTRIBUTING.md), [Security policy](SECURITY.md), [Agent conventions](AGENTS.md)

## Principles

- Local-first; no account; no automatic telemetry.
- X access is read-only. Local organization and deletion never change your X account.
- Evidence-only answers by default, with citations to the exact archived passage.
- Private data never belongs in this repository. Tests use synthetic fixtures only.

## License

Apache-2.0 for original code ([LICENSE](LICENSE), [NOTICE](NOTICE)). Models and dependencies keep their own terms.

## Development

Requires Node.js 24 and pnpm (pinned via `packageManager`).

```sh
pnpm install --frozen-lockfile
pnpm build && pnpm lint && pnpm test && pnpm license-check
```

`prototypes/` is a separate throwaway F0 project with its own install; see its README.
