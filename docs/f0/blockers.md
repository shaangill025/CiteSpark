# F0 blockers and revised plan

F0 ran on one Apple M1 8 GB Mac with no admin rights, no paid accounts, and synthetic data only. The items below could not be validated here. No launch requirement is dropped. Each has a revised plan and the milestone layer where it must pass.

| # | F0 test or item (§14) | Why it could not be validated | Revised plan | Must pass by |
|---|---|---|---|---|
| B1 | Cross-platform packaging without developer tools | Only macOS is available. No Windows or Linux machines or VMs. | Build installers on GitHub Actions runners (macos-14, macos-13, windows-2022, ubuntu-24.04). Install on clean VMs (Windows 11, Ubuntu 24.04, Fedora) with no Node or compilers present. T14 checklist per platform. | M2 Electron shell layer (first installers), M5 (full T14) |
| B2 | Code signing and notarization | Apple Developer ID and a Windows code signing certificate cost money. The spec authorizes no paid subscriptions. Unsigned apps show Gatekeeper and SmartScreen warnings, which conflicts with "no developer setup" (Q23). | **Owner decision needed.** Options: buy certificates, use a free signing program for open-source projects if one accepts the project, or ship unsigned previews with documented steps until 1.0. | Before beta |
| B3 | 100,000-post search on the 8 GB reference setup | Partly done. This Mac is an 8 GB M1 and keyword search passed. No 8 GB x64 Windows machine. True cold-cache numbers need `purge` (admin). Electron and better-sqlite3 not yet in the loop. | Re-run `prototypes/fts5-bench` in CI on Windows and Linux (runner RAM differs, so label it). Owner or contributor runs it on an 8 GB Windows laptop. Run after reboot for cold numbers. Port the harness into the M3 search layer. | M3 search layer |
| B4 | Local generation and tool-use model quality | Models are multi-gigabyte downloads and there is no frozen evaluation set yet (T12 says to freeze it before tuning). | Build the frozen set in M4 from synthetic and owner-authorized material, then evaluate the PROPOSED models on the 8 GB and 16 GB classes. If no 8 GB configuration passes, publish 16 GB as the requirement for local answers (DAT-02 allows separate requirements). AI-01 still requires one evaluated local configuration. | M4 evaluation layer |
| B5 | OCR and transcription resource behavior | Needs model downloads and a media fixture. Time-boxed out. | Run tesseract.js and whisper.cpp on synthetic media (generated images with known text, synthesized speech) and record peak RSS and throughput on the reference machine. | M3 OCR and transcription layers |
| B6 | Plugin pairing | Needs the desktop core and the plugin, which do not exist yet. | Design in ADR 0006. T06 suite runs against the real socket. | M1 IPC layer (extension), M2 plugin layer |
| B7 | Vault rename and conflict handling | Needs the sync engine. | Design in ADR 0007. T04 property and filesystem tests. | M2 sync layers |
| B8 | Capture restart with real authorized samples | Fixture rights not confirmed. Synthetic fixtures passed T01. Real X data must never enter the repository. | Owner runs the capture suite against their own account locally. Results are summarized without content. | M1 extension layer |
| B9 | xarchive identity | No canonical repository found. `sytelus/xarchive` (MIT, MV3) is the likely match. | **Owner confirmation needed.** Pin the tested export versions for MIG-01 and T09. | M1 xarchive import layer |
| B10 | Chrome Local Network Access | Unverified whether extension-origin requests are exempt from LNA prompts. | Avoided: ADR 0006 uses native messaging, not localhost HTTP. The local model sidecar is called only by the desktop core, not the browser. | Resolved by design |
| B11 | Electron memory on 8 GB | Not measured. Core search process used 130 MB. | Measure packaged idle and search memory on the reference machine. If it threatens DAT-02, reduce renderer work first; reconsider ADR 0001 only if that fails. | M2 Electron shell layer |
| B12 | CJK keyword search | `unicode61` does not segment CJK. Trigram works but is 6.8 times larger. | Ship trigram as opt-in and document it (LAN-01). Evaluate an ICU tokenizer later if users need it. | M3 search layer |

## Owner decisions requested

1. Approve the implementation plan (`implementation-plan.md`). M0 exit requires it.
2. Code signing approach (B2).
3. Confirm `sytelus/xarchive` is the intended xarchive project (B9).
4. Accept scrypt (age's built-in KDF) for password backups instead of Argon2id (ADR 0008).
5. Accept moving extension pairing and IPC into M1 (capture needs it). Plugin pairing stays in M2.
6. Confirm reference hardware for T11: Apple M1 8 GB plus an 8 GB Windows x64 laptop (§18 asks to confirm reference hardware before implementation).
7. Confirm fixture rights for owner-run real capture samples (§18).
