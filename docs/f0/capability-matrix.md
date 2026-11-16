# Capability matrix

This is the planned launch matrix. Each cell states what F0 established. **Measured** means a prototype ran here. **Planned** means a milestone layer must test it. **PROPOSED** means a chosen default that is not validated. T14 requires every supported platform to pass a clean install and have a tested local AI path on suitable hardware before 1.0.

## Platforms (Q09, T14)

| Platform | Architecture | Desktop app | Native messaging host | Local socket | Status |
|---|---|---|---|---|---|
| macOS 13 or later | arm64 | Electron, dmg | `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` and Edge equivalent | Unix socket, 0700 dir | Store, FTS5, vector, backup prototypes **measured** on M1 8 GB. Packaging planned (M2). |
| macOS 13 or later | x64 | Electron, dmg | same | same | Planned (CI macos-13). |
| Windows 10 22H2, Windows 11 | x64 | Electron, NSIS | `HKCU\Software\Google\Chrome\NativeMessagingHosts\…` and `…\Microsoft\Edge\NativeMessagingHosts\…` | Named pipe, user DACL | Planned (CI windows-2022, clean VM for T14). |
| Ubuntu 22.04 and 24.04, Fedora 40 or later | x64 | Electron, AppImage + deb + rpm | `~/.config/google-chrome/NativeMessagingHosts/`, `~/.config/microsoft-edge/NativeMessagingHosts/` | Unix socket, 0700 dir | Planned (CI ubuntu-24.04, VMs). |
| Windows arm64, Linux arm64 | arm64 | | | | Not in the launch matrix (PROPOSED). Electron supports them; add if CI and test hardware exist. |

OS versions are PROPOSED (see `resolved-engineering-details.md`).

## Browsers (Q20, CAP-01)

| Browser | Capture extension | Status |
|---|---|---|
| Google Chrome (stable) | MV3, native messaging | Planned. Required by Q20. |
| Microsoft Edge (stable) | Same build, Edge Add-ons or unpacked | Planned. Required by Q20. |
| Other Chromium browsers (Brave, Vivaldi) | May work, untested | Best effort, not advertised. |
| Firefox, Safari | | Deferred by Q20. |

## Local model configurations (AI-01, Q24, Q27, Q60)

Core features (capture, sync, keyword and semantic search) target 8 GB RAM without a generation model loaded (DAT-02). Answer and research models have separate published requirements.

| Configuration | Hardware class | Generation | Embeddings | Transcription | OCR | Answers | Research | Status |
|---|---|---|---|---|---|---|---|---|
| Core only | 8 GB, any supported OS | none | bge-small-en-v1.5 | whisper base (opt-in) | tesseract `eng` (opt-in) | cloud or none | cloud or none | Keyword measured. Embedding, OCR, transcription PROPOSED. |
| Local small | 8 GB with Apple Silicon or 16 GB x64 | Qwen3-4B-Instruct-2507 Q4_K_M | bge-small-en-v1.5 | whisper base | tesseract | yes | yes, if T10 passes | PROPOSED. Not evaluated. |
| Local standard | 16 GB or more | Qwen3-8B Q4_K_M | nomic-embed-text-v1.5 | whisper small | tesseract | yes | yes | PROPOSED. Not evaluated. The likely "evaluated local configuration" for AI-01. |
| External runtime | any | user's Ollama, LM Studio, or other OpenAI-compatible server | Citspark local embeddings | | | per model | per model, tool calling required | Planned. Capability probe at connect time. |

Acceleration: Metal on Apple Silicon; CPU everywhere; Vulkan or CUDA builds of llama.cpp on Windows and Linux where available (PROPOSED, depends on packaging size).

## Cloud providers (AI-01, Q11, Q58, SEC-01)

All opt-in per library and per provider. Context leaves the machine only after the privacy filter (SEC-02).

| Provider | Adapter | Quick answers | Research (tool calls) | Structured output | Streaming | Status |
|---|---|---|---|---|---|---|
| OpenAI | native | yes | yes | JSON schema | yes | Planned (M4). Tested against mock in CI; live test with user key. |
| Anthropic | native | yes | yes | tool-based schema | yes | Planned (M4). |
| Google Gemini | native | yes | yes | response schema | yes | Planned (M4). |
| OpenAI-compatible | configurable base URL, key, model | yes | if the endpoint supports tools | if supported, otherwise validated JSON | yes | Planned (M4). Capabilities probed and shown; unsupported modes disabled (T10). |

Exact model names per provider are chosen at M4 and recorded with the frozen evaluation results. They change too often to fix in F0.

## Obsidian plugin (PLG-01, PLG-02, Q52, Q53)

| Item | Status |
|---|---|
| Obsidian desktop (macOS, Windows, Linux) | Planned. Connects over the local socket (ADR 0006). |
| Obsidian mobile | Not supported. The plugin is desktop-only (`isDesktopOnly: true`). Mobile edits reach Citspark through the user's vault sync (Q08). |
| Minimum Obsidian version | PROPOSED: 1.6 or later; fixed in M2-09. |
| Plugin-free sync | Required (SYN-01). Works with the plugin disabled. |
| States shown | disconnected, unpaired, incompatible, desktop not running (PLG-02). |
| Community directory | Owner decision. Publishing is not authorized by the spec. Must follow Obsidian developer policies (network use disclosed, no telemetry, no obfuscation). |

## Language (LAN-01)

| Capability | Support |
|---|---|
| Interface | English |
| Unicode storage and display | All languages preserved |
| Keyword search | Good for space-delimited scripts with `unicode61`. CJK and other unsegmented scripts need the optional trigram index (6.8 times larger). Exact-ID lookup always works. |
| Tokenizer limits (M3-01) | `unicode61 remove_diacritics 2` folds diacritics (`cafe` finds `café`) and treats an unbroken CJK run as one token, so part of a CJK run is not a keyword match. Substring search needs a generation built with trigram and a query of at least 3 characters. Whether trigram is available is recorded per index generation, so changing it means building a new generation. Chunk offsets are UTF-16 indices and never split a grapheme. |
| Embeddings, OCR, transcription, AI quality | English evaluated. Other languages best effort, not advertised. |
