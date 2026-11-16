# Resolved engineering details

§16 lists details to resolve in F0 or before their dependent milestone. Each is resolved below. **Measured** means a prototype supports it. **PROPOSED** means it is a default chosen with reasoning but not validated; the listed layer must confirm or change it. Changing a PROPOSED default does not need a new ADR unless it changes a decision.

| Item (§16) | Resolution | Status | Confirmed in |
|---|---|---|---|
| CPU and OS version matrix | macOS 13+ (arm64, x64); Windows 10 22H2 and 11 (x64); Ubuntu 22.04 and 24.04, Fedora 40+ (x64). See `capability-matrix.md`. | PROPOSED | M2 packaging, M5 compatibility |
| Exact local models | Qwen3-4B-Instruct-2507 Q4_K_M (8 GB class), Qwen3-8B Q4_K_M (16 GB), bge-small-en-v1.5 and nomic-embed-text-v1.5, whisper base and small, tesseract `eng`. Apache-2.0 or MIT only by default. | PROPOSED | M4 evaluation (T10, T12) |
| Runtime and framework | Electron + TypeScript, Node core without Electron imports, SQLite via better-sqlite3, llama.cpp and whisper.cpp sidecars, tesseract.js. ADRs 0001 to 0004, 0009. | Decided | |
| Archive encryption format | age v1 over a tar archive with a SHA-256 manifest; scrypt passphrase recipient or keychain-held X25519 recipient. ADR 0008. | Decided, round-trip measured | M2 backup (full T08) |
| Performance fixture composition | 100,000 posts (70% short, 25% medium, 5% long), 15,000 linked articles chunked at about 1,000 characters (216,283 chunks), about 5% non-Latin text, seeded so runs repeat. Generator in `prototypes/fts5-bench/corpus.ts`. Later: add synthetic media (10,000 images, 500 audio clips) for OCR and transcription runs. | Text fixture measured. Media fixture PROPOSED. | M3 OCR and transcription |
| Default media budget | `min(20 GiB, 50% of free space at setup)`, never less than 2 GiB free left on the volume. At the limit, pause new media downloads and keep text capture going (MED-04). User adjustable. | PROPOSED | M1 media store |
| Backup retention defaults | Keep 7 daily, 4 weekly, 6 monthly. Never delete the newest verified backup. Prune only after the new backup verifies. | PROPOSED | M2 backup |

## Other defaults needed by M1 to M4

| Item | Default | Status | Reason |
|---|---|---|---|
| Capture lease TTL | 60 s, renewed every 20 s while a page is in flight | PROPOSED | Short enough to recover from a crash in about a minute, long enough for slow pages. Prototype used the same lease check. |
| Capture pacing | 1 page per 3 to 6 s with jitter, back off on 429 honoring `Retry-After`, daily page budget 1,500 | PROPOSED | Conservative per CAP-05. Tune with owner-run samples. |
| Pairing code | 6 digits, single use, 2 minutes, lock after 5 wrong tries | PROPOSED | ADR 0006 |
| Protocol frame limit | 1 MB toward the extension (Chrome limit), 8 MB toward the core | PROPOSED | Chrome native messaging caps host-to-extension at 1 MB |
| Chunk size | about 1,000 characters with 150-character overlap for articles; one chunk per post | Measured (search) | Used by the benchmark. Retrieval quality to be checked at T10. |
| Embedding dimension | 384 (8 GB class), 768 (16 GB class), recorded per index generation | PROPOSED | ADR 0003 |
| Vector store | int8 per-vector scaled, exact scan | Measured (latency) | ADR 0003 |
| Research budget defaults | 25 tool calls, 5 minutes elapsed, 60,000 input tokens, context 16,000 tokens | PROPOSED | AI-05. Adjust after T10 runs. |
| Heavy job concurrency on 8 GB | 1 heavy job (model inference, OCR, transcription) at a time | PROPOSED | DAT-02, MED-05 |
| SQLite durability | WAL, `synchronous=FULL` on capture and sync writes | Measured (T01) | ADR 0002 |
| scrypt work factor | `logN = 18`, tuned to about 1 s on the reference machine | PROPOSED | ADR 0008 |
| Diagnostics bundle | JSON with versions, settings (keys redacted), job states, last 1,000 log lines with credentials and source text redacted; preview before export | PROPOSED | SEC-04, SEC-05 |
| Reference machine (T11) | Apple M1, 8 GB (measured). A Windows x64 8 GB machine is also needed. | Partly met | See `blockers.md` |
