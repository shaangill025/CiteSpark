# License inventory

Q33: original Citspark code is Apache-2.0. Dependencies and models keep their own terms. This inventory lists candidates named in the ADRs. Versions are as observed in November 2026 from the package registry or GitHub. CI must enforce the allowlist from M1 onward (ADR 0009).

**Compatibility rule**: permissive licenses (MIT, BSD, ISC, Apache-2.0, public domain) are compatible for bundling. MPL-2.0 is acceptable for unmodified dev-only or file-level use. LGPL is acceptable only as a separately replaceable dynamic library and is avoided where possible. GPL and AGPL components are not bundled.

## Runtime dependencies (shipped)

| Component | Use | License | Version seen | Compatible | Notes |
|---|---|---|---|---|---|
| Electron | desktop shell | MIT | 45.3.3 | Yes | Bundles Chromium (BSD-3 and others) and Node (MIT). Include Electron's `LICENSES.chromium.html`. |
| SQLite | store | Public domain | 3.53.x | Yes | |
| better-sqlite3 | SQLite binding | MIT | 13.2.0 | Yes | |
| React | UI | MIT | 19.x | Yes | |
| React Aria Components | accessible UI | Apache-2.0 | 1.x | Yes | |
| zod | schemas | MIT | 4.6.7 | Yes | |
| ulid / ulidx | stable note IDs | MIT | | Yes | |
| node-diff3 | three-way merge | MIT | 4.0.0 | Yes | |
| chokidar | file watching | MIT | 6.0.0 | Yes | |
| age-encryption (typage) | backup encryption | BSD-3-Clause | 0.3.1 | Yes | Used by `prototypes/backup-age`. |
| noise-handshake | IPC channel (ADR 0011) | Apache-2.0 | 4.2.1 | Yes | Chosen in M1-06. No async key-agreement callback, so the wrapped-key fallback applies (ADR 0011). |
| sodium-universal | X25519, ChaCha20-Poly1305, BLAKE2b for the IPC channel | MIT | 5.0.1 | Yes | Pulls in sodium-native 5.2.1 (MIT) in Node. Browser builds need sodium-javascript (MIT), added in M1-08. |
| b4a, nanoassert, require-addon, which-runtime | transitive dependencies of noise-handshake and sodium-universal | Apache-2.0, ISC | 1.9.0, 2.0.0, 1.3.0, 1.4.0 | Yes | |
| parse5 | HTML parsing for linked-page metadata, text and meta charset (M1-11) | MIT | 8.0.1 | Yes | Pulls in entities 8.1.0 (BSD-2-Clause). |
| @chainsafe/libp2p-noise (not adopted) | IPC channel (ADR 0006) | Apache-2.0 OR MIT | 17.0.0 | Yes | Rejected in M1-06: synchronous crypto interface and XX only (ADR 0011). |
| tar-stream | backup container | MIT | | Yes | |
| llama.cpp (`llama-server`) | local generation and embeddings | MIT | 1.0.0 | Yes | Prebuilt binaries per OS and backend. |
| whisper.cpp | transcription | MIT | 1.9.5 | Yes | |
| tesseract.js | OCR | Apache-2.0 | 7.0.0 | Yes | Slowing maintenance (last push May 2026). Native Tesseract (Apache-2.0, 5.5.4) is the fallback. |
| usearch | approximate vector index (fallback only) | Apache-2.0 | 2.26.6 | Yes | Not adopted at launch (ADR 0003). |
| Dexie | IndexedDB in the extension, if needed | Apache-2.0 | 4.x | Yes | |

## Build and test (not shipped)

| Component | License | Version seen | Notes |
|---|---|---|---|
| pnpm | MIT | 10.21 (installed), 12.21 (latest) | |
| TypeScript | Apache-2.0 | | |
| Vite, esbuild | MIT | | |
| electron-builder | MIT | | |
| Vitest | MIT | 5.1.0 | |
| Playwright | Apache-2.0 | 1.65.1 | |
| fast-check | MIT | | |
| ESLint, typescript-eslint, Prettier | MIT | | |
| axe-core | MPL-2.0 | | Dev only, unmodified. Acceptable. |
| obsidian (type definitions) | MIT | 1.14.4 | |

## Reuse candidates inspected (CAP-01)

| Project | License | Pinned commit | Decision |
|---|---|---|---|
| twitter-web-exporter (`prinsss`) | MIT | `ddf2b0c823680b904daae166f3eb05b81950ce7e` | Reference only (ADR 0005). Runtime dependencies loaded from a CDN; per-dependency licenses must be checked before copying any code. |
| xarchive (`sytelus/xarchive`, confirmed by owner, Q2) | MIT | `ae9d0263617a200ce142e64fb2ddc6301ebf19cf` | Reference only. Its export format is the first import target (Q38). Vendors Dexie (Apache-2.0). |

Any copied code keeps its MIT notice in NOTICE with the source commit.

## Considered and not adopted

| Component | License | Reason |
|---|---|---|
| Tauri | Apache-2.0 / MIT | ADR 0001. License was not the reason. |
| sqlite-vec | Apache-2.0 / MIT | Pre-1.0 (0.1.9). |
| hnswlib-node | Apache-2.0 | npm package not maintained. |
| LanceDB | Apache-2.0 | Large native dependency, not needed at this scale. |
| Ollama | MIT | Supported through the OpenAI-compatible connector, not bundled. |
| diff-match-patch | Apache-2.0 | Repository archived. |
| keytar | MIT | Archived. Electron `safeStorage` replaces it. |
| openpgp.js | LGPL-3.0 | ADR 0008. |
| FFmpeg | LGPL-2.1+ (GPL with `--enable-gpl`) | Avoided. Electron's Chromium decodes audio (PROPOSED, ADR 0004). If FFmpeg becomes necessary, ship an LGPL-only dynamic build. |

## Models (downloaded by the user, not bundled in the installer)

| Model | License | Default |
|---|---|---|
| Qwen3-4B-Instruct-2507 | Apache-2.0 | 8 GB class generation (PROPOSED) |
| Qwen3-8B | Apache-2.0 | 16 GB class generation (PROPOSED) |
| Phi-4-mini-instruct | MIT | Alternative |
| Mistral-7B-Instruct-v0.3 | Apache-2.0 | Alternative |
| bge-small-en-v1.5 | MIT | 8 GB class embeddings (PROPOSED) |
| nomic-embed-text-v1.5 | Apache-2.0 | 16 GB class embeddings (PROPOSED) |
| all-MiniLM-L6-v2 | Apache-2.0 | Alternative embeddings |
| Whisper base, small (weights) | Apache-2.0 on Hugging Face (OpenAI code MIT) | Transcription |
| tessdata `eng` | Apache-2.0 | OCR |
| Llama 3.x | Llama Community License (custom, use restrictions) | User may add. Not offered by default. |
| Gemma 3 | Gemma Terms of Use (custom) | User may add. Not offered by default. |

GGUF conversions on Hugging Face inherit the base model license. The model manager shows the license and source URL before download.

## Services (user-supplied keys, not dependencies)

OpenAI, Anthropic, and Google Gemini APIs are governed by each provider's terms, which the user accepts directly. Citspark ships no keys.

## Open items

- Per-dependency license check of the full transitive tree, generated by CI from the M1 scaffold onward.
- Model license text should be re-read at the pinned revision when the model manager is built (M4).
