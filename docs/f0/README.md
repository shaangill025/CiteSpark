# F0 feasibility results

F0 (spec §14, milestone M0) produces measured prototypes, a license inventory, architecture decisions, and a capability matrix. M0 exits when the owner approves the implementation plan.

| Document | Contents |
|---|---|
| [`../adr/`](../adr/README.md) | Ten architecture decisions, each comparing options with evidence |
| [`benchmarks.md`](benchmarks.md) | Prototype results, hardware, method, caveats |
| [`license-inventory.md`](license-inventory.md) | Dependencies, models, reuse candidates, Apache-2.0 compatibility |
| [`capability-matrix.md`](capability-matrix.md) | Platforms, browsers, local model configurations, cloud providers, plugin |
| [`resolved-engineering-details.md`](resolved-engineering-details.md) | §16 open items resolved, with PROPOSED markers |
| [`blockers.md`](blockers.md) | What F0 could not validate and the revised plan |
| [`owner-decisions.md`](owner-decisions.md) | Owner decisions Q1–Q9, accepted 2026-11-16 (M0 exit) |
| [`implementation-plan.md`](implementation-plan.md) | M1 to M5 as a stack of small PR layers with requirements and acceptance tests |

## Status of the §14 F0 tests

| F0 test | Result | Evidence |
|---|---|---|
| Capture restart, synthetic fixtures | **Pass (process crash)** | T01 prototype: 15 tests, SIGKILL at 9 points, mutation check (`benchmarks.md`) |
| Capture restart, real authorized samples | Not run | Needs owner-run capture (blockers B8) |
| Cross-platform packaging without developer tools | Not run | macOS only here (B1, B2) |
| Plugin pairing | Designed | ADR 0006; T06 suite in M1-06 and M2-09 (B6) |
| Vault rename and conflict handling | Designed | ADR 0007; T04 in M2-04 and M2-05 (B7) |
| 100,000-post search on the 8 GB reference setup | **Pass (keyword, macOS)** | Ranked keyword warm p95 66.6 ms (worst shape 107 ms) vs PROPOSED 1 s target on M1 8 GB. Vector scan p95 125 ms (int8) at 216k chunks. Windows 8 GB and true cold cache open (B3). |
| Local generation and tool-use model quality | Not run | Needs frozen evaluation set (B4) |
| OCR and transcription resource behavior | Not run | Needs media fixtures and models (B5) |
| Encryption and restore | **Pass (encryption)** | age round-trip; wrong password, corruption, and truncation fail (damaged archives emit a verified prefix first, so restore stages output). Full restore in M2-08. |
| License compatibility | **Pass (candidates)** | `license-inventory.md`. CI enforcement from M1-01. |

No launch requirement is dropped. Everything not run has a layer that must pass it.
