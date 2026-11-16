import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import * as realFs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JobStore,
  LeaseError,
  MediaStore,
  defaultMediaBudget,
  migrate,
  type Lease,
  type MediaFetch,
  type MediaStoreOptions,
} from "./index.ts";

// Synthetic media served by a loopback test server only. The loopback fetch below is a test seam;
// production callers inject the guarded fetcher (M1-11).
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const blobA = Buffer.alloc(10_000, 7);
const blobB = Buffer.alloc(10_000, 9);
const blobC = Buffer.alloc(10_000, 3);
const bodies: Record<string, Buffer> = { "/a": blobA, "/a-dup": blobA, "/b": blobB, "/c": blobC };

let server: Server;
let base: string;
let root: string;
let dropAfter: number | null;
let ranged: string[];
let requests: string[];
let handler: ((req: IncomingMessage, res: ServerResponse) => boolean) | null;

const testFetch: MediaFetch = (url, init) => fetch(url, init);

/** Serve `body` in 1,000-byte chunks with small gaps so writes interleave. */
const trickle = (res: ServerResponse, body: Buffer, headers: Record<string, string | number>) => {
  res.writeHead(200, headers);
  let i = 0;
  const tick = () => {
    if (i >= body.length) return void res.end();
    res.write(body.subarray(i, i + 1_000));
    i += 1_000;
    setTimeout(tick, 2);
  };
  tick();
};

beforeEach(async () => {
  dropAfter = null;
  ranged = [];
  requests = [];
  handler = null;
  root = mkdtempSync(join(tmpdir(), "citspark-media-"));
  server = createServer((req, res) => {
    requests.push(req.url ?? "");
    if (handler?.(req, res)) return;
    const body = bodies[req.url ?? ""];
    if (!body) {
      res.writeHead(404).end();
      return;
    }
    const range = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = range ? Number(range[1]) : 0;
    if (range) ranged.push(req.headers.range ?? "");
    const slice = body.subarray(start);
    res.writeHead(range ? 206 : 200, {
      "content-type": "image/png",
      "content-length": slice.length,
      etag: '"v1"',
      ...(range ? { "content-range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });
    if (dropAfter !== null && !range) {
      res.write(slice.subarray(0, dropAfter));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    res.end(slice);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

const enospc = () => Object.assign(new Error("no space left on device"), { code: "ENOSPC" });

const setup = (opts: Partial<MediaStoreOptions> = {}) => {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO source (id, source_type) VALUES ('s1', 'post'), ('s2', 'post')").run();
  let t = 1_000;
  const clock = { now: () => t, set: (v: number) => void (t = v) };
  const media = new MediaStore(db, {
    root,
    budgetBytes: 1_000_000,
    minFreeBytes: 0,
    freeBytes: () => 10_000_000,
    fetch: testFetch,
    now: () => clock.now(),
    ...opts,
  });
  const jobs = new JobStore(db);
  const now = opts.now ?? clock.now;
  let n = 0;
  /** Download one entry under a freshly acquired, retained lease; then release it. */
  const dl = async (id: number) => {
    const jobId = `dl${n++}`;
    jobs.create({ id: jobId, kind: "media" });
    const lease = jobs.acquire(jobId, "w", now(), 60_000);
    if (!lease) throw new Error("not acquired");
    const outcome = await media.download(id, { jobs, jobId, lease });
    if (jobs.get(jobId).state === "running") jobs.transition(jobId, lease, now(), "queued");
    return outcome;
  };
  return { db, media, jobs, clock, dl };
};
const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : [];

describe("content-addressed blobs and reference counts (MED-01)", () => {
  it("stores a download under its sha256 and records size, mime and ref count", async () => {
    const { media, db, dl } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    expect(await dl(d.id)).toBe("complete");
    const row = db.prepare("SELECT * FROM media").get() as Record<string, unknown>;
    expect(row["content_hash"]).toBe(sha(blobA));
    expect(row["mime_type"]).toBe("image/png");
    expect(row["blob_path"]).toBe(`blobs/${sha(blobA).slice(0, 2)}/${sha(blobA)}`);
    expect(readFileSync(join(root, row["blob_path"] as string))).toEqual(blobA);
    expect(media.blob(sha(blobA))).toMatchObject({ sizeBytes: 10_000, refCount: 1 });
    expect(files(join(root, "tmp"))).toEqual([]);
  });

  it("deduplicates identical bytes and counts references", async () => {
    const { media, dl } = setup();
    await dl(media.enqueue("s1", `${base}/a`).id);
    await dl(media.enqueue("s2", `${base}/a-dup`).id);
    expect(files(join(root, "blobs"))).toHaveLength(1);
    expect(media.blob(sha(blobA))?.refCount).toBe(2);
    expect(media.usedBytes()).toBe(10_000);
    media.release(sha(blobA));
    expect(media.blob(sha(blobA))?.refCount).toBe(1);
    expect(media.unreferenced()).toEqual([]);
    media.release(sha(blobA));
    expect(media.unreferenced()).toEqual([sha(blobA)]);
    expect(() => media.release(sha(blobA))).toThrow();
    expect(existsSync(join(root, "blobs"))).toBe(true);
    expect(files(join(root, "blobs"))).toHaveLength(1);
  });

  it("enqueue is idempotent per source and url, and rejects non-http or credentialed urls", () => {
    const { media } = setup();
    const a = media.enqueue("s1", `${base}/a`);
    expect(media.enqueue("s1", `${base}/a`).id).toBe(a.id);
    expect(() => media.enqueue("s1", "file:///etc/passwd")).toThrow(/http/);
    expect(() => media.enqueue("s1", "http://user:pw@example.invalid/x")).toThrow(/credentials/);
    expect(() => media.enqueue("s1", "not a url")).toThrow(/url/);
  });

  it("marks a missing remote file failed without a blob", async () => {
    const { media, dl } = setup();
    const d = media.enqueue("s1", `${base}/missing`);
    expect(await dl(d.id)).toBe("failed");
    expect(media.getDownload(d.id).state).toBe("failed");
    expect(media.usedBytes()).toBe(0);
  });

  it("requires an injected fetch boundary and never follows redirects itself", async () => {
    const db = new Database(":memory:");
    migrate(db);
    expect(
      () =>
        new MediaStore(db, {
          root,
          budgetBytes: 1,
          minFreeBytes: 0,
        } as unknown as MediaStoreOptions),
    ).toThrow(/fetch/);
    const { media, dl } = setup();
    handler = (req, res) => {
      if (req.url !== "/redirect") return false;
      res.writeHead(302, { location: `${base}/a` }).end();
      return true;
    };
    const d = media.enqueue("s1", `${base}/redirect`);
    expect(await dl(d.id)).toBe("failed");
    expect(media.getDownload(d.id)).toMatchObject({
      state: "failed",
      error: "redirect not followed",
    });
    expect(requests).toEqual(["/redirect"]);
    expect(media.blob(sha(blobA))).toBeUndefined();
  });
});

describe("resumable downloads (MED-01)", () => {
  it("keeps the partial file when the connection drops and resumes with a Range request", async () => {
    const { media, dl } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    dropAfter = 4_000;
    expect(await dl(d.id)).toBe("interrupted");
    const partial = media.getDownload(d.id);
    expect(partial.state).toBe("pending");
    expect(partial.bytesReceived).toBeGreaterThan(0);
    expect(partial.bytesReceived).toBeLessThan(10_000);
    expect(statSync(join(root, "tmp", `${d.id}.part`)).size).toBe(partial.bytesReceived);

    expect(await dl(d.id)).toBe("complete");
    expect(ranged).toEqual([`bytes=${partial.bytesReceived}-`]);
    expect(media.blob(sha(blobA))?.sizeBytes).toBe(10_000);
  });

  it("discards a stale partial when the server ignores Range and sends the whole body", async () => {
    const { media, dl } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    dropAfter = 3_000;
    await dl(d.id);
    dropAfter = null;
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": blobA.length }).end(blobA);
      return true;
    };
    expect(await dl(d.id)).toBe("complete");
    expect(media.blob(sha(blobA))?.sizeBytes).toBe(10_000);
  });

  it("uses the Content-Range representation length, not the partial body length", async () => {
    // Review: with 4,000 bytes saved, `bytes 4000-5999/10000` + Content-Length 2,000 must not
    // finalize a 6,000-byte truncated blob.
    const { media, dl } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    dropAfter = 4_000;
    expect(await dl(d.id)).toBe("interrupted");
    handler = (req, res) => {
      const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      if (!m) return false;
      const start = Number(m[1]);
      const end = Math.min(start + 1_999, blobA.length - 1);
      res
        .writeHead(206, {
          etag: '"v1"',
          "content-length": end - start + 1,
          "content-range": `bytes ${start}-${end}/${blobA.length}`,
        })
        .end(blobA.subarray(start, end + 1));
      return true;
    };
    expect(await dl(d.id)).toBe("complete");
    expect(media.blob(sha(blobA))?.sizeBytes).toBe(10_000);
    expect(media.getDownload(d.id)).toMatchObject({ totalBytes: 10_000, bytesReceived: 10_000 });
    expect(requests.filter((u) => u === "/a").length).toBeGreaterThan(2);
  });

  it.each([
    ["missing Content-Range", (s: number) => ({ "content-length": 10_000 - s })],
    ["wrong start", (s: number) => ({ "content-range": `bytes ${s + 1}-9999/10000` })],
    ["end before start", (s: number) => ({ "content-range": `bytes ${s}-${s - 1}/10000` })],
    ["end beyond total", (s: number) => ({ "content-range": `bytes ${s}-10000/10000` })],
    ["total changed", (s: number) => ({ "content-range": `bytes ${s}-11999/12000` })],
    [
      "length disagrees",
      (s: number) => ({ "content-range": `bytes ${s}-9999/10000`, "content-length": 5 }),
    ],
  ])("rejects a 206 with %s and never completes from it", async (_, headers) => {
    const { media, dl } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    dropAfter = 4_000;
    await dl(d.id);
    handler = (req, res) => {
      const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      if (!m) return false;
      const start = Number(m[1]);
      res.writeHead(206, { etag: '"v1"', ...headers(start) });
      res.end(blobA.subarray(start));
      return true;
    };
    expect(await dl(d.id)).toBe("interrupted");
    expect(media.getDownload(d.id)).toMatchObject({ state: "pending", bytesReceived: 0 });
    expect(media.blob(sha(blobA))).toBeUndefined();
    handler = null;
    dropAfter = null;
    expect(await dl(d.id)).toBe("complete");
    expect(media.blob(sha(blobA))?.sizeBytes).toBe(10_000);
  });

  it("does not finalize a 200 body shorter than its Content-Length", async () => {
    const { media, dl } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    handler = (_req, res) => {
      res.writeHead(200, { "content-length": 10_000 });
      res.write(blobA.subarray(0, 6_000));
      setTimeout(() => res.destroy(), 20);
      return true;
    };
    expect(await dl(d.id)).toBe("interrupted");
    expect(media.blob(sha(blobA))).toBeUndefined();
  });
});

describe("media budget (MED-04, Q28)", () => {
  it("pauses new media at the limit, keeps queued entries, evicts nothing, and text continues", async () => {
    const { media, dl } = setup({ budgetBytes: 15_000 });
    const first = media.enqueue("s1", `${base}/a`);
    const second = media.enqueue("s1", `${base}/b`);
    expect(await dl(first.id)).toBe("complete");
    expect(await dl(second.id)).toBe("paused_budget");
    expect(media.getDownload(second.id).state).toBe("paused_budget");
    expect(media.usedBytes()).toBeLessThanOrEqual(15_000);
    expect(media.blob(sha(blobA))).toBeDefined();
    expect(existsSync(join(root, "blobs"))).toBe(true);
    expect(media.status()).toMatchObject({ mediaPaused: true, textWritesAllowed: true });
  });

  it("stops mid-stream when an unknown-length body would cross the limit", async () => {
    const { media, dl } = setup({ budgetBytes: 4_000 });
    handler = (_req, res) => {
      res.writeHead(200);
      res.write(blobA);
      res.end();
      return true;
    };
    const d = media.enqueue("s1", `${base}/chunked`);
    expect(await dl(d.id)).toBe("paused_budget");
    expect(media.usedBytes()).toBeLessThanOrEqual(4_000);
  });

  it("resumes once the user raises the budget", async () => {
    const { media, dl } = setup({ budgetBytes: 5_000 });
    const d = media.enqueue("s1", `${base}/a`);
    expect(await dl(d.id)).toBe("paused_budget");
    media.setBudget(50_000);
    expect(await dl(d.id)).toBe("complete");
  });

  it("keeps concurrent jobs within one shared budget", async () => {
    const { media, jobs } = setup({ budgetBytes: 15_000 });
    handler = (req, res) => {
      const body = bodies[req.url ?? ""];
      if (!body) return false;
      trickle(res, body, {}); // unknown length: only the per-chunk reservation can stop it
      return true;
    };
    media.enqueue("s1", `${base}/a`);
    media.enqueue("s2", `${base}/b`);
    jobs.create({ id: "j1", kind: "media" });
    jobs.create({ id: "j2", kind: "media" });
    const outcomes = await Promise.all([
      media.runJob(jobs, "j1", "w1"),
      media.runJob(jobs, "j2", "w2"),
    ]);
    expect(outcomes).toContain("paused");
    expect(media.usedBytes()).toBeLessThanOrEqual(15_000);
  });

  it("computes the proposed default budget", () => {
    const GiB = 1024 ** 3;
    expect(defaultMediaBudget(100 * GiB)).toBe(20 * GiB);
    expect(defaultMediaBudget(10 * GiB)).toBe(5 * GiB);
    expect(defaultMediaBudget(3 * GiB)).toBe(1 * GiB);
    expect(defaultMediaBudget(1 * GiB)).toBe(0);
  });
});

describe("disk safety (MED-04)", () => {
  it("pauses all writes when free space falls under the floor", async () => {
    let free = 10_000_000;
    const { media, dl } = setup({ minFreeBytes: 1_000_000, freeBytes: () => free });
    const d = media.enqueue("s1", `${base}/a`);
    free = 500_000;
    expect(await dl(d.id)).toBe("paused_disk");
    expect(media.status()).toMatchObject({ mediaPaused: true, textWritesAllowed: false });
    expect(files(join(root, "blobs"))).toEqual([]);
    free = 10_000_000;
    expect(media.status().textWritesAllowed).toBe(true);
    expect(await dl(d.id)).toBe("complete");
  });

  it("treats a simulated ENOSPC write as disk full and latches until space is rechecked", async () => {
    let full = true;
    const { media, dl } = setup({
      fs: {
        write: async (h, c) => {
          if (full) throw enospc();
          await h.write(c);
        },
      },
    });
    const d = media.enqueue("s1", `${base}/a`);
    expect(await dl(d.id)).toBe("paused_disk");
    expect(media.status().textWritesAllowed).toBe(false);
    expect(media.getDownload(d.id).state).toBe("paused_disk");
    full = false;
    expect(media.status().textWritesAllowed).toBe(false);
    media.recheckDisk();
    expect(media.status().textWritesAllowed).toBe(true);
    expect(await dl(d.id)).toBe("complete");
  });

  it.each(["open", "mkdir", "rename"] as const)(
    "pauses on ENOSPC from %s, keeps recoverable partial state, and resumes",
    async (op) => {
      let full = true;
      const real = realFs[op] as (...a: unknown[]) => Promise<unknown>;
      const { media, jobs, dl } = setup({
        fs: {
          [op]: async (...args: unknown[]) => {
            if (full) throw enospc();
            return real(...args);
          },
        },
      });
      const d = media.enqueue("s1", `${base}/a`);
      jobs.create({ id: "j", kind: "media" });
      expect(await media.runJob(jobs, "j", "w")).toBe("paused");
      expect(jobs.get("j")).toMatchObject({ state: "paused", stopReason: "disk space low" });
      expect(media.getDownload(d.id).state).toBe("paused_disk");
      expect(media.status().textWritesAllowed).toBe(false);
      expect(media.blob(sha(blobA))).toBeUndefined();
      const fetchedBefore = requests.length;
      full = false;
      media.recheckDisk();
      expect(await dl(d.id)).toBe("complete");
      expect(media.blob(sha(blobA))?.refCount).toBe(1);
      // A fully received part file survives a failed finalize and is not fetched again.
      if (op !== "open") expect(requests.length).toBe(fetchedBefore);
      expect(files(join(root, "tmp"))).toEqual([]);
    },
  );
});

describe("download job on the job store (CAP-04 lease)", () => {
  it("completes the job after downloading every entry", async () => {
    const { media, jobs } = setup();
    jobs.create({ id: "j1", kind: "media" });
    media.enqueue("s1", `${base}/a`);
    media.enqueue("s2", `${base}/b`);
    expect(await media.runJob(jobs, "j1", "w")).toBe("complete");
    expect(jobs.get("j1").state).toBe("complete");
    expect(media.usedBytes()).toBe(20_000);
  });

  it("pauses the job on budget, keeps pending entries, and finishes after resume with more budget", async () => {
    const { media, jobs, clock } = setup({ budgetBytes: 15_000 });
    jobs.create({ id: "j1", kind: "media" });
    media.enqueue("s1", `${base}/a`);
    const b = media.enqueue("s1", `${base}/b`);
    expect(await media.runJob(jobs, "j1", "w")).toBe("paused");
    expect(jobs.get("j1")).toMatchObject({ state: "paused", stopReason: "media budget reached" });
    expect(media.getDownload(b.id).state).toBe("paused_budget");
    media.setBudget(100_000);
    jobs.resume("j1");
    clock.set(2_000);
    expect(await media.runJob(jobs, "j1", "w")).toBe("complete");
    expect(media.blob(sha(blobB))).toBeDefined();
  });

  it("marks the job partial when a download is interrupted and completes after resume", async () => {
    const { media, jobs } = setup();
    jobs.create({ id: "j1", kind: "media" });
    media.enqueue("s1", `${base}/a`);
    dropAfter = 2_000;
    expect(await media.runJob(jobs, "j1", "w")).toBe("partial");
    dropAfter = null;
    jobs.resume("j1");
    expect(await media.runJob(jobs, "j1", "w")).toBe("complete");
    expect(media.blob(sha(blobA))?.refCount).toBe(1);
  });

  it("never completes a job whose downloads failed, including after resume", async () => {
    const { media, jobs } = setup();
    jobs.create({ id: "j1", kind: "media" });
    media.enqueue("s1", `${base}/a`);
    media.enqueue("s1", `${base}/missing`);
    expect(await media.runJob(jobs, "j1", "w")).toBe("partial");
    expect(jobs.get("j1")).toMatchObject({ state: "partial", stopReason: "1 download(s) failed" });
    jobs.resume("j1");
    expect(await media.runJob(jobs, "j1", "w")).toBe("partial");
    expect(jobs.get("j1")).toMatchObject({ state: "partial", stopReason: "1 download(s) failed" });
    expect(media.blob(sha(blobA))?.refCount).toBe(1);
  });

  it("pauses the job on disk pressure", async () => {
    const { media, jobs } = setup({ minFreeBytes: 1, freeBytes: () => 0 });
    jobs.create({ id: "j1", kind: "media" });
    media.enqueue("s1", `${base}/a`);
    expect(await media.runJob(jobs, "j1", "w")).toBe("paused");
    expect(jobs.get("j1").stopReason).toBe("disk space low");
  });

  it("returns not_acquired when the job lease is held elsewhere", async () => {
    const { media, jobs, clock } = setup();
    jobs.create({ id: "j1", kind: "media" });
    jobs.acquire("j1", "other", clock.now(), 60_000);
    expect(await media.runJob(jobs, "j1", "w")).toBe("not_acquired");
  });

  it("gives concurrent jobs disjoint downloads (no shared .part file)", async () => {
    const { media, jobs, db } = setup();
    handler = (req, res) => {
      const body = bodies[req.url ?? ""];
      if (!body) return false;
      trickle(res, body, { "content-length": body.length, etag: '"v1"' });
      return true;
    };
    for (const p of ["/a", "/b", "/c"]) media.enqueue("s1", `${base}${p}`);
    jobs.create({ id: "j1", kind: "media" });
    jobs.create({ id: "j2", kind: "media" });
    const out = await Promise.all([media.runJob(jobs, "j1", "w1"), media.runJob(jobs, "j2", "w2")]);
    expect(out).toEqual(["complete", "complete"]);
    expect([...requests].sort()).toEqual(["/a", "/b", "/c"]);
    const want = [blobA, blobB, blobC].map((b) => ({ h: sha(b), r: 1 }));
    want.sort((x, y) => (x.h < y.h ? -1 : 1));
    expect(db.prepare("SELECT content_hash h, ref_count r FROM blob ORDER BY h").all()).toEqual(
      want,
    );
  });

  it("refuses to download an entry claimed by another live lease", async () => {
    const { media, jobs, clock } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    jobs.create({ id: "holder", kind: "media" });
    jobs.create({ id: "other", kind: "media" });
    const holder = jobs.acquire("holder", "h", clock.now(), 60_000)!;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    handler = (req, res) => {
      if (req.url !== "/a") return false;
      res.writeHead(200, { "content-length": 10_000, etag: '"v1"' });
      res.write(blobA.subarray(0, 1_000));
      void gate.then(() => res.end(blobA.subarray(1_000)));
      return true;
    };
    const first = media.download(d.id, { jobs, jobId: "holder", lease: holder });
    await new Promise((r) => setTimeout(r, 50));
    const other = jobs.acquire("other", "o", clock.now(), 60_000)!;
    expect(await media.download(d.id, { jobs, jobId: "other", lease: other })).toBe("claimed");
    release();
    expect(await first).toBe("complete");
    expect(requests).toEqual(["/a"]);
  });

  it("renews with an advancing clock during long transfers", async () => {
    const ttl = 1_000;
    let t = 1_000;
    const expiries: (number | null)[] = [];
    const ref: { jobs?: JobStore } = {};
    const { media, jobs } = setup({
      leaseTtlMs: ttl,
      now: () => t,
      fs: {
        write: async (h, c) => {
          t += 400; // each chunk takes 0.4 TTL; ten chunks outlast the initial lease
          expiries.push(ref.jobs!.get("j").leaseExpiresAt);
          await h.write(c);
        },
      },
    });
    ref.jobs = jobs;
    handler = (_req, res) => {
      trickle(res, blobA, { "content-length": 10_000, etag: '"v1"' });
      return true;
    };
    media.enqueue("s1", `${base}/a`);
    jobs.create({ id: "j", kind: "media" });
    expect(await media.runJob(jobs, "j", "w")).toBe("complete");
    expect(new Set(expiries).size).toBeGreaterThan(1);
    expect(Math.max(...(expiries as number[]))).toBeGreaterThan(1_000 + ttl);
  });

  it("stops writing and commits nothing once the lease is taken over mid-transfer", async () => {
    const ttl = 1_000;
    let t = 1_000;
    let writes = 0;
    const ref: { jobs?: JobStore } = {};
    const { media, jobs, db } = setup({
      leaseTtlMs: ttl,
      now: () => t,
      fs: {
        write: async (h, c) => {
          writes++;
          if (writes === 1) {
            t += ttl + 1; // stalled past expiry; another worker reclaims the job
            expect(ref.jobs!.acquire("j", "thief", t, ttl)).not.toBeNull();
          }
          await h.write(c);
        },
      },
    });
    ref.jobs = jobs;
    handler = (_req, res) => {
      trickle(res, blobA, { "content-length": 10_000, etag: '"v1"' });
      return true;
    };
    const d = media.enqueue("s1", `${base}/a`);
    jobs.create({ id: "j", kind: "media" });
    expect(await media.runJob(jobs, "j", "w")).toBe("lease_lost");
    expect(writes).toBe(1);
    expect(db.prepare("SELECT COUNT(*) n FROM blob").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM media").get()).toEqual({ n: 0 });
    expect(media.getDownload(d.id).state).not.toBe("complete");
    expect(jobs.get("j")).toMatchObject({ state: "running", leaseOwner: "thief" });
  });

  it("rejects a stale or forged lease token before any network or file work", async () => {
    const { media, jobs, clock } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    jobs.create({ id: "j", kind: "media" });
    const lease = jobs.acquire("j", "w", clock.now(), 60_000)!;
    const stale: Lease = { owner: "w", generation: lease.generation + 1 };
    await expect(media.download(d.id, { jobs, jobId: "j", lease: stale })).rejects.toBeInstanceOf(
      LeaseError,
    );
    const forged = "w" as unknown as Lease;
    await expect(media.download(d.id, { jobs, jobId: "j", lease: forged })).rejects.toBeInstanceOf(
      LeaseError,
    );
    expect(requests).toEqual([]);
    expect(files(join(root, "tmp"))).toEqual([]);
  });
});
