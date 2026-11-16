# F0 owner decisions

The owner accepted every recommendation for the nine F0 review items on 2026-11-16. These decisions close M0 (§14, §16). Where a decision depends on later validation, the layer that must validate it is named.

| # | Item | Decision | Applies in | Docs updated |
|---|---|---|---|---|
| Q1 | Code signing (B2) | Ship unsigned previews with documented install steps for Gatekeeper and SmartScreen. Apply to SignPath Foundation (free signing for open-source projects) now. Decide on paid certificates (Apple Developer ID, Windows Azure Trusted Signing) before beta. | M2-01 (unsigned previews), M5-02 (signed builds) | `blockers.md` B2 |
| Q2 | xarchive identity (B9) | xarchive is `sytelus/xarchive`. Pin the tested export versions in M1-09. | M1-09 | `blockers.md` B9, `license-inventory.md` |
| Q3 | Backup password KDF | Accept scrypt through age (`logN = 18`, tuned to about 1 s on the reference machine) instead of Argon2id. | M2-08 | ADR 0008 |
| Q4 | IPC placement | Extension pairing and IPC move into M1 (M1-06). Obsidian plugin pairing stays in M2 (M2-09). | M1-06, M2-09 | ADR 0006 |
| Q5 | T11 reference hardware (§18) | Apple M1 8 GB plus an 8 GB Windows x64 laptop. A contributor's machine or a rented VM is acceptable if results are labelled with the machine. Linux is measured in CI only. | M3-02, M3-03 | `blockers.md` B3, `capability-matrix.md`, `resolved-engineering-details.md` |
| Q6 | Real capture and fixture rights (B8, §18) | The owner runs real capture locally on their own account: one full pass of a large collection and one resume, before M1-08 merges. Only content-free summaries enter the repository. Test fixtures stay synthetic. | M1-08 | `blockers.md` B8 |
| Q7 | PDF export (Q15) | Out of scope for v1.0. M2-12 exports Markdown, CSV, and JSON. | M2-12 | `implementation-plan.md` |
| Q8 | Noise library | Spike `noise-handshake` in M1-06. It must run in an MV3 service worker and accept a WebCrypto key-agreement callback. Fallback: `@chainsafe/libp2p-noise`. If neither works, write a superseding ADR for wrapped keys. | M1-06 | ADR 0006, `license-inventory.md` |
| Q9 | Implementation plan | Approved as amended. M0 exit. | M1–M5 | `implementation-plan.md` |

Decisions that depend on later validation are still not achieved. The Noise library spike (Q8), the reference-hardware runs (Q5), the owner-run capture (Q6), and the SignPath application (Q1) remain open work in the layers named above.
