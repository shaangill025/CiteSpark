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
  commit with idempotent replay (M1-02 to M1-04; T01 in `packages/store/src/t01.test.ts`)
- `packages/protocol`: message schemas, framing, version negotiation, and request-ID idempotency (M1-05)
- `packages/ipc`, `packages/core/src/ipc`, `packages/native-host`: Noise pairing and encrypted local IPC with scopes
  and revocation ([ADR 0011](docs/adr/0011-noise-ipc-implementation.md); T06 core suite in
  `packages/core/src/ipc/t06.test.ts`) (M1-06)
- `packages/capture-x`: versioned X response parser tested against synthetic fixtures only; not validated against
  live X (M1-07)
- `packages/store` media library: content-addressed media blobs with hashes, resumable Range downloads on fenced job
  leases, and a storage limit that pauses downloads without eviction (M1-10; migration 5). No production media
  fetcher is wired yet: the network guard (private-network, loopback, DNS-rebinding and redirect validation, M1-11)
  and wiring to capture and acquisition-status UI remain pending
- `packages/sync`: sync merge core (note identity, three-way merge, conflict records) with no vault file access yet
  (M2-04; T04 property tests in `packages/sync/src/t04.property.test.ts`)

Not yet merged on main: the browser extension and live capture (M1-08), imports, linked sources, trash, the
desktop app, vault file sync, backups, saved-library search and retrieval, citations, and AI answers. See the
[traceability matrix](docs/spec/traceability.md) for per-requirement status.

| Milestone | Scope | Status |
| --- | --- | --- |
| F0/M0 | Feasibility prototypes, license inventory, architecture decisions | complete (plan approved; follow-up gates open) |
| M1 | Data foundation: archive, capture, import, media, recoverable storage | in progress (M1-01 to M1-07 and M1-10 merged; M1-08, M1-09, M1-11, M1-12 pending) |
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
