# 0001. Desktop shell

Status: Decided. Memory footprint PROPOSED.
Requirements: Q09, Q23, Q27, DAT-02, ACC-01, ACC-02, T13, T14, §4, §14

## Context

The desktop app owns the library, sync, retrieval, privacy enforcement, model execution, and job coordination (§4). It must install on macOS, Windows, and Linux without developer tools (Q09, Q23). Core features target 8 GB RAM (DAT-02). Accessibility is a release requirement with screen-reader testing on every platform (ACC-01, T13). The spec proposes TypeScript for the extension and UI (§14).

## Options

| Criterion | Electron | Tauri 2 |
|---|---|---|
| Language of the desktop core | TypeScript in Node. Same language as extension, plugin, and UI. | Rust core, or a bundled Node sidecar. The sidecar gives back most of the size advantage. |
| Rendering engine | Chromium on every OS. | WKWebView on macOS, WebView2 on Windows, WebKitGTK on Linux. |
| Screen-reader support | Chromium accessibility tree on all three OSes. | WebKitGTK with Orca on Linux is the weakest of the three engines. Three engines triple the T13 matrix. |
| Baseline memory | Higher. A Chromium renderer plus Node main process (about 150 to 250 MB, inferred from public reports, not measured here). | Lower. System webview. |
| Installer size | About 100 MB or more. | About 10 MB plus any sidecars. |
| E2E automation | Playwright drives Electron directly. | WebDriver through tauri-driver. No macOS WKWebView driver. |
| Native modules | better-sqlite3 has Electron prebuilds. | rusqlite in Rust, or the same Node modules in a sidecar. |
| Packaging and updates | electron-builder (MIT): dmg, nsis, AppImage, deb, rpm, signed updates. | Tauri bundler: similar targets, signed updates. |
| License | MIT | Apache-2.0 / MIT |

## Evidence

- The shared domain logic (capture commit, merge, retrieval, privacy filters) is TypeScript in every other component. One language keeps the privacy filter and protocol schemas in one place rather than mirrored across Rust and TypeScript (SEC-02 depends on one enforcement point).
- The capture-commit and FTS5 prototypes ran in plain Node with `node:sqlite`. The same code runs in Electron's main or utility process with no FFI layer.
- Core memory in F0: the FTS5 search process peaked at 130 MB RSS with the full 100,000-post index open (`docs/f0/benchmarks.md`). An Electron shell adds its own overhead on top. That sum is not measured yet.
- Tauri's memory advantage is real but does not decide the 8 GB target. The search process, a renderer, and the OS fit with room to spare. Local models are separately budgeted by spec (DAT-02).

## Decision

Use Electron. Keep the desktop core (`packages/core`) a plain Node library with no Electron imports. It runs inside an Electron `utilityProcess` in the app and in plain Node for tests and the dev harness. The renderer is a client of the core over the same versioned protocol as the extension and plugin (ADR 0006), so the UI holds no privileged state.

UI: React (MIT) with React Aria Components (Apache-2.0) for accessible primitives (focus management, keyboard interaction, live regions). The Obsidian plugin reuses the same components where Obsidian's DOM allows.

Hardening defaults: `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false` in every renderer, a strict CSP, no remote content in privileged windows, `safeStorage` for secrets (SEC-04), and electron-builder signed updates (SEC-06).

## Consequences

- Larger downloads than Tauri. Publish the installer size and idle memory in the compatibility matrix.
- Electron's support window is short (about three majors). Plan a scheduled Electron upgrade layer each quarter.
- Chromium is bundled. Its media stack can decode audio for transcription without shipping FFmpeg separately (ADR 0004).

## Still to validate

- PROPOSED: idle and search-time memory of the packaged app on the 8 GB reference machine, measured in the M2 shell layer.
- PROPOSED: screen-reader behavior on Windows (NVDA, Narrator), macOS (VoiceOver), and Linux (Orca) for the T13 workflows.
- Code signing and notarization need owner-procured certificates. See `docs/f0/blockers.md`.
