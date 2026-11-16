# Citspark

> Preserve sources. Retrieve evidence. Learn with traceable answers.

Citspark is a planned local-first desktop application (macOS, Windows, Linux) that preserves your saved X posts and
linked sources, makes them searchable, and answers questions from them with exact, verifiable citations. It includes
two-way Obsidian synchronization and an optional Obsidian companion plugin.

## Status: specification only, nothing implemented

This repository currently contains the approved product and engineering specification and the delivery plan.
**No product code exists yet, and no feature described here is implemented or tested.** Planned work ships as clearly
labeled alpha/beta previews; version 1.0 waits until every required capability passes its acceptance gates.

| Milestone | Scope | Status |
| --- | --- | --- |
| F0/M0 | Feasibility prototypes, license inventory, architecture decisions | not started |
| M1 | Data foundation: archive, capture, import, media, recoverable storage | not started |
| M2 | Desktop app, pairing, two-way vault sync, backups | not started |
| M3 | Search, OCR/transcripts, organization, graph, exact citations | not started |
| M4 | Local and cloud answers, bounded research, plugin research UI | not started |
| M5 | Accessibility, compatibility, security review, docs, release | not started |

## Documents

- [Specification v1.0](docs/spec/citspark-spec-v1.0.md)
- [Traceability matrix](docs/spec/traceability.md): requirement, milestone, acceptance test, status
- [Contributing](CONTRIBUTING.md), [Security policy](SECURITY.md), [Agent conventions](AGENTS.md)

## Principles

- Local-first; no account; no automatic telemetry.
- X access is read-only. Local organization and deletion never change your X account.
- Evidence-only answers by default, with citations to the exact archived passage.
- Private data never belongs in this repository. Tests use synthetic fixtures only.

## License

Apache-2.0 for original code ([LICENSE](LICENSE), [NOTICE](NOTICE)). Models and dependencies keep their own terms.
