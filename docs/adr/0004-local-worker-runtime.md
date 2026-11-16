# 0004. Local worker runtime

Status: Decided. Model choices and resource limits PROPOSED.
Requirements: AI-01, MED-02, MED-05, DAT-02, SEC-01, Q11, Q24, Q25, Q27, Q33, Q60, §14, §16

## Context

Local generation, embeddings, OCR, and transcription must work offline, without developer tools, inside a bounded memory budget, and be cancellable (DAT-02, MED-05). At least one evaluated local configuration must support both answers and research (AI-01, Q60). Cloud providers are optional and opt-in (SEC-01, Q11). §16 leaves the runtime and models unresolved.

## Options

### Generation and embeddings

| Criterion | llama.cpp `llama-server` sidecar | Bundled Ollama | node-llama-cpp in-process | onnxruntime / transformers.js |
|---|---|---|---|---|
| Isolation | Separate process. Kill to cancel or reclaim memory. | Separate daemon, shared with other apps. | In the core process. A crash takes the core down. | In-process or worker. |
| Packaging | Prebuilt binaries per OS and backend (Metal, CUDA, Vulkan, CPU). MIT. | Installer and service we do not control. MIT. | Native addon with prebuilds. MIT. | npm packages. MIT / Apache-2.0. |
| API | OpenAI-compatible HTTP, embeddings endpoint, GBNF grammar for tool calls. | OpenAI-compatible. | JavaScript API. | Embeddings strong; generation weak at 4B+ scale. |
| Model format | GGUF, wide availability. | GGUF. | GGUF. | ONNX. |

### Transcription

whisper.cpp sidecar (MIT, Metal and CPU builds) versus transformers.js Whisper. whisper.cpp is faster on CPU and runs out of process.

### OCR

tesseract.js (Apache-2.0, WASM, no native install) versus native Tesseract (Apache-2.0, per-OS packaging) versus onnxruntime OCR models. tesseract.js ships with the app and runs in a worker. Its release cadence has slowed (last push May 2026), which is a maintenance risk.

## Decision

- **Generation and embeddings:** bundle `llama-server` binaries and run one sidecar per loaded model. The core starts it on a loopback port with a random API key per launch, or on a Unix socket where the build supports it, restarts it on crash, and kills it on cancel, memory pressure, or idle timeout. Users with Ollama, LM Studio, or similar connect through the OpenAI-compatible provider adapter (AI-01, Q58). Citspark does not bundle them.
- **Transcription:** bundle whisper.cpp as a sidecar. Decode audio with Electron's Chromium media stack in a hidden utility window to 16 kHz PCM. Do not ship FFmpeg, which avoids GPL builds (PROPOSED: verify codec coverage for X video formats).
- **OCR:** tesseract.js in a worker thread with bundled `eng` traineddata. Add other languages on demand. Keep a native Tesseract adapter behind the same interface in case tesseract.js stalls.
- **Resource governor:** one heavy job at a time on 8 GB machines. Each job declares an expected memory cost. The governor refuses to start a job that would breach the budget and pauses media work when capture or the UI need memory (MED-05).
- **Default local models (PROPOSED, chosen for license and size; quality not evaluated):**

| Role | 8 GB class | 16 GB class | License |
|---|---|---|---|
| Generation and tool use | Qwen3-4B-Instruct-2507, Q4_K_M (about 2.5 GB) | Qwen3-8B, Q4_K_M (about 5 GB) | Apache-2.0 |
| Alternative generation | Phi-4-mini-instruct, Q4 | | MIT |
| Embeddings | bge-small-en-v1.5 (384 dimensions) | nomic-embed-text-v1.5 (768) | MIT / Apache-2.0 |
| Transcription | whisper base | whisper small | Apache-2.0 (weights), MIT (whisper.cpp) |
| OCR | tesseract `eng` | | Apache-2.0 |

- Llama and Gemma models have custom licenses with use restrictions. Users may add them, but Citspark does not download them by default. The model manager shows each model's license before download (Q33).
- Model downloads are user-initiated, verified by SHA-256, and never start during a query (MED-05).

## Consequences

- Per-OS sidecar binaries must be built, signed, and tested in the compatibility matrix (T14).
- A loopback HTTP port for `llama-server` is reachable by other local processes. The random per-launch key limits this. Prefer the socket transport where available.

## Still to validate

- PROPOSED: generation and tool-use quality on the frozen evaluation set (T10, M4-06). Not run in F0: multi-gigabyte downloads and no evaluation set yet.
- PROPOSED: OCR and transcription peak memory and throughput on the reference machine (M3-05, M3-06).
- Whether the chosen `llama-server` build supports Unix sockets on every OS.
