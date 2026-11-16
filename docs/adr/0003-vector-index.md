# 0003. Vector index

Status: Decided. Scan cost measured. Retrieval quality PROPOSED.
Requirements: RET-01, RET-03, DAT-02, AI-03, T10, T11

## Context

Hybrid search combines keyword and semantic results (RET-01). The index must be rebuildable from canonical data, published atomically with rollback (RET-03), and bounded in memory on 8 GB machines (DAT-02). PROPOSED T11 target: hybrid p95 under 3 s.

## Options

| Criterion | Exact scan over quantized vectors | sqlite-vec | usearch HNSW | LanceDB |
|---|---|---|---|---|
| Recall | Exact (int8 quantization error only). | Exact scan (vec0). | Approximate. | Approximate or exact. |
| Memory at 216k × 384 | 83 MB int8, 332 MB float32. | Similar, inside SQLite. | Vectors plus graph. | On disk, columnar. |
| Atomic generations | Files or BLOBs per generation, switched with the FTS generation. | Tables per generation. | Index file per generation. | Table versions. |
| Maturity | Our code, about 100 lines. | Pre-1.0 (0.1.9), slow release cadence. | Mature, Apache-2.0. | Mature, Apache-2.0, large native dependency. |
| Packaging | None. | Loadable SQLite extension per platform. | Native addon. | Native addon, larger. |

## Evidence

From `prototypes/vector-scan` (single JavaScript thread, random unit vectors, 384 dimensions, 40 queries × 5 runs):

| Vectors | Format | Memory | p50 | p95 |
|---|---|---|---|---|
| 100,000 | float32 | 153.6 MB | 38.2 ms | 43.0 ms |
| 100,000 | int8 + per-vector scale | 38.8 MB | 39.7 ms | 43.5 ms |
| 216,283 | float32 | 332 MB | 87.2 ms | 144 ms |
| 216,283 | int8 + per-vector scale | 83.9 MB | 84.9 ms | 125 ms |

- int8 with one scale per vector, applied to each score: top-20 overlap with exact float32 was 0.99 (100k) and 0.98 (216k) on random vectors. Random vectors say nothing about real retrieval quality.
- The scan is compute-bound scalar JavaScript, not memory-bound (332 MB in 90 ms is about 3.7 GB/s).
- Inferred hybrid budget at 216k chunks: ranked keyword p95 about 67 ms (worst shape 107 ms) plus vector p95 about 125 to 145 ms plus query embedding (not measured). Well under 3 s.

## Decision

- Exact top-k scan over int8-quantized vectors (per-vector scale), stored per index generation in a flat file next to the database and loaded into a worker thread. Generation switching follows the FTS generation in ADR 0002.
- Embedding model and dimension are recorded per generation. A model change triggers a new generation, never mixed vectors.
- Fuse keyword and vector results with reciprocal rank fusion, then apply trash and privacy filters before anything is returned (RET-02, SEC-02).
- Keep the scan behind a `VectorIndex` interface. If measured p95 on the reference machine exceeds the budget, replace it with usearch HNSW behind the same interface. Do not adopt sqlite-vec while it is pre-1.0.

## Consequences

- Memory grows linearly: about 0.4 KB per chunk at 384 dimensions in int8. One million chunks would need about 400 MB and a slower scan. The compatibility matrix states the tested library size.
- Worker threads can split the scan across cores if needed.

## Still to validate

- PROPOSED: retrieval quality of the chosen embedding model and int8 quantization on the frozen evaluation set (T10, M4).
- Query embedding latency on the reference machine (M3-03).
