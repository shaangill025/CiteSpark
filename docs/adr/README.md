# Architecture decision records

Each record compares at least two options against the requirements it serves, names the evidence, and picks one. A decision is a default for implementation, not a scope change. Spec §1 still governs: if a later test disproves a decision, write a superseding ADR and keep the requirement.

Labels follow the spec. **Decided** means F0 picked the option. **PROPOSED** marks a value or claim that F0 did not validate. Each record lists what still needs validation and in which milestone layer it happens (see [`docs/f0/implementation-plan.md`](../f0/implementation-plan.md)).

| ADR | Decision | Status |
|---|---|---|
| [0001](0001-desktop-shell.md) | Electron shell. The desktop core is a plain Node package that runs without Electron. React with React Aria for the UI. | Decided. Memory footprint PROPOSED. |
| [0002](0002-canonical-store.md) | SQLite (better-sqlite3) is the canonical store. FTS5 external-content index with `unicode61`, published in index generations. | Decided. Keyword latency measured. |
| [0003](0003-vector-index.md) | Exact scan over int8 vectors kept per index generation. No approximate index at launch. | Decided. Scan cost measured, quality PROPOSED. |
| [0004](0004-local-worker-runtime.md) | Managed llama.cpp server sidecars for generation and embeddings, whisper.cpp for transcription, tesseract.js for OCR. | Decided. Model choices PROPOSED. |
| [0005](0005-extension-architecture.md) | Citspark-owned MV3 adapter that passively reads X's own responses while it scrolls; it never builds requests or touches credentials. Learn from twitter-web-exporter and xarchive with attribution, vendor neither. | Decided. Real-session check PROPOSED. |
| [0006](0006-local-ipc-pairing.md) | Native messaging bridge and a per-user local socket. Noise handshake with per-client static keys, pairing confirmed by a 6-digit code, every frame encrypted. No localhost HTTP. | Decided. Partly superseded by 0011. |
| [0007](0007-obsidian-sync-engine.md) | Section-aware three-way merge (diff3) with stable frontmatter IDs and stored base snapshots. Delete versus edit becomes a conflict. Included user notes are never body-edited. | Decided. |
| [0008](0008-backup-encryption.md) | age v1 file format over a tar archive with a hashed manifest. | Decided. Throughput measured. |
| [0009](0009-monorepo-tooling.md) | pnpm workspaces, TypeScript project references, Vitest, ESLint. No task runner until build time needs one. | Decided. |
| [0010](0010-testing-strategy.md) | Test pyramid mapped to T01 to T15, with synthetic fixtures and release-blocking security suites. | Decided. |
| [0011](0011-noise-ipc-implementation.md) | noise-handshake (BLAKE2b). XX pairing with a committed code that the client shows and the user types into the desktop. IK per connection. Client key wrapped by a non-extractable WebCrypto key. | Decided. Partly supersedes 0006. |

## Template

```md
# NNNN. Title

Status: Decided | PROPOSED | Superseded by NNNN
Requirements: IDs from the spec

## Context
## Options
## Evidence
## Decision
## Consequences
## Still to validate
```
