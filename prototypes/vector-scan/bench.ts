import { cpus, loadavg, release, totalmem } from 'node:os';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const DIM = 384;
const K = 20;
const QUERIES = 40;
const RUNS = 5;
const SIZES = [100_000, 216_283];

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function unitVectors(n: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n * DIM);
  for (let i = 0; i < n; i++) {
    let norm = 0;
    for (let d = 0; d < DIM; d++) {
      const x = r() * 2 - 1;
      out[i * DIM + d] = x;
      norm += x * x;
    }
    norm = Math.sqrt(norm);
    for (let d = 0; d < DIM; d++) out[i * DIM + d] /= norm;
  }
  return out;
}

// Symmetric int8 with one scale per vector (ADR 0003): x ≈ q * scale, scale = maxAbs / 127.
function quantize(v: Float32Array): { q: Int8Array; scale: Float32Array } {
  const n = v.length / DIM;
  const q = new Int8Array(v.length);
  const scale = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * DIM;
    let maxAbs = 0;
    for (let d = 0; d < DIM; d++) maxAbs = Math.max(maxAbs, Math.abs(v[o + d]));
    const s = maxAbs > 0 ? maxAbs / 127 : 1;
    scale[i] = s;
    for (let d = 0; d < DIM; d++) q[o + d] = Math.round(v[o + d] / s);
  }
  return { q, scale };
}

function topK(scores: Float32Array): number[] {
  const idx: number[] = [];
  const val: number[] = [];
  for (let i = 0; i < scores.length; i++) {
    const s = scores[i];
    if (val.length === K && s <= val[K - 1]) continue;
    let j = val.length < K ? val.length : K - 1;
    while (j > 0 && val[j - 1] < s) {
      val[j] = val[j - 1];
      idx[j] = idx[j - 1];
      j--;
    }
    val[j] = s;
    idx[j] = i;
  }
  return idx;
}

function scanF32(base: Float32Array, n: number, q: Float32Array, scores: Float32Array): number[] {
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * DIM;
    for (let d = 0; d < DIM; d++) s += base[o + d] * q[d];
    scores[i] = s;
  }
  return topK(scores);
}

function scanI8(base: Int8Array, baseScale: Float32Array, n: number, q: Int8Array, scores: Float32Array): number[] {
  for (let i = 0; i < n; i++) {
    let s = 0;
    const o = i * DIM;
    for (let d = 0; d < DIM; d++) s += base[o + d] * q[d];
    scores[i] = s * baseScale[i];
  }
  return topK(scores);
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil((p / 100) * xs.length) - 1)];
const r2 = (x: number) => Math.round(x * 100) / 100;

const results: Record<string, unknown>[] = [];
for (const n of SIZES) {
  const base = unitVectors(n, 7);
  const base8 = quantize(base);
  const qs = unitVectors(QUERIES, 99);
  const scores = new Float32Array(n);
  const times = { f32: [] as number[], i8: [] as number[] };
  let overlap = 0;
  let checksum = 0;
  for (let q = 0; q < QUERIES; q++) {
    const qv = qs.subarray(q * DIM, (q + 1) * DIM);
    scanF32(base, n, qv, scores);
    scanI8(base8.q, base8.scale, n, quantize(qv).q, scores);
  }
  for (let run = 0; run < RUNS; run++) {
    for (let q = 0; q < QUERIES; q++) {
      const qv = qs.subarray(q * DIM, (q + 1) * DIM);
      const q8 = quantize(qv).q;
      let t = performance.now();
      const exact = scanF32(base, n, qv, scores);
      times.f32.push(performance.now() - t);
      t = performance.now();
      const approx = scanI8(base8.q, base8.scale, n, q8, scores);
      times.i8.push(performance.now() - t);
      checksum += exact[0] + approx[0];
      if (run === 0) overlap += approx.filter((i) => exact.includes(i)).length / K;
    }
  }
  results.push({
    vectors: n,
    dim: DIM,
    f32Bytes: base.byteLength,
    i8Bytes: base8.q.byteLength + base8.scale.byteLength,
    f32Ms: { n: times.f32.length, p50: r2(pct(times.f32, 50)), p95: r2(pct(times.f32, 95)), max: r2(Math.max(...times.f32)) },
    i8Ms: { n: times.i8.length, p50: r2(pct(times.i8, 50)), p95: r2(pct(times.i8, 95)), max: r2(Math.max(...times.i8)) },
    i8Top20OverlapWithExact: r2(overlap / QUERIES),
    checksum,
  });
}

const report = {
  date: new Date().toISOString(),
  environment: { cpu: cpus()[0].model, logicalCores: cpus().length, ramBytes: totalmem(), os: `${process.platform} ${release()}`, node: process.version, loadAvg: loadavg() },
  method: 'exact brute-force top-20 dot product, single JS thread, synthetic random unit vectors; measures scan cost only, not retrieval quality',
  results,
};
mkdirSync(join(import.meta.dirname, 'results'), { recursive: true });
writeFileSync(join(import.meta.dirname, 'results', 'vector-scan.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
