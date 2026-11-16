import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import * as realFs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JobStore,
  LeaseError,
  MIGRATIONS,
  MediaStore,
  defaultMediaBudget,
  migrate,
  type Lease,
  type MediaFetch,
  type MediaStoreOptions,
} from "./index.ts";

// Synthetic media served by a loopback test server only. The loopback fetch below is a test seam;
// the ENR-03 guarded fetcher (M1-11) is not yet wired for production.
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
/** The part file an entry currently records; each execution attempt writes its own. */
const partOf = (db: Database.Database, id: number): string => {
  const { part_file } = db.prepare("SELECT part_file FROM media_download WHERE id = ?").get(id) as {
    part_file: string;
  };
  return join(root, "tmp", part_file);
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
    const { media, dl, db } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    dropAfter = 4_000;
    expect(await dl(d.id)).toBe("interrupted");
    const partial = media.getDownload(d.id);
    expect(partial.state).toBe("pending");
    expect(partial.bytesReceived).toBeGreaterThan(0);
    expect(partial.bytesReceived).toBeLessThan(10_000);
    expect(statSync(partOf(db, d.id)).size).toBe(partial.bytesReceived);
    expect(files(join(root, "tmp"))).toHaveLength(1);

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

  it("a direct download of a stopped (failed) entry fetches nothing and takes no claim", async () => {
    const { media, dl, db } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    // Stopped by another component (e.g. trash) using the migration 5 `failed` state.
    db.prepare("UPDATE media_download SET state = 'failed', error = 'stopped' WHERE id = ?").run(
      d.id,
    );
    expect(await dl(d.id)).toBe("failed");
    expect(requests).toEqual([]);
    expect(
      db
        .prepare(
          "SELECT state, error, claim_job_id, claim_token, part_file FROM media_download WHERE id = ?",
        )
        .get(d.id),
    ).toEqual({
      state: "failed",
      error: "stopped",
      claim_job_id: null,
      claim_token: null,
      part_file: null,
    });
    expect(files(join(root, "tmp"))).toEqual([]);
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

  // A response that makes the worker discard its partial file (record(..., { reset: true })).
  const resets: [string, (have: number) => Response][] = [
    ["416 range not satisfiable", () => new Response(null, { status: 416 })],
    [
      "invalid content-length",
      () => new Response(null, { status: 200, headers: { "content-length": "nope" } }),
    ],
    [
      "invalid content-range",
      (have) =>
        new Response(new Uint8Array(10), {
          status: 206,
          headers: { "content-range": `bytes ${have + 1}-${have + 10}/10000`, etag: '"v1"' },
        }),
    ],
  ];
  const takeovers = ["the same job reacquired", "another job claiming the entry"] as const;

  it.each(resets.flatMap(([why, res]) => takeovers.map((how) => [why, how, res] as const)))(
    "a stale worker cannot unlink the partial after takeover (%s, %s)",
    async (_why, how, resetResponse) => {
      const ttl = 1_000;
      let t = 1_000;
      const calls: ((url: string) => Promise<Response>)[] = [];
      const ref: { jobs?: JobStore; media?: MediaStore } = {};
      const { media, jobs, db, dl } = setup({
        leaseTtlMs: ttl,
        now: () => t,
        fetch: (url, init) => {
          const next = calls.shift();
          return next ? next(url) : testFetch(url, init);
        },
      });
      ref.jobs = jobs;
      ref.media = media;
      const d = media.enqueue("s1", `${base}/a`);
      dropAfter = 4_000;
      expect(await dl(d.id)).toBe("interrupted");
      dropAfter = null;
      const kept = readFileSync(partOf(db, d.id));
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.length).toBeLessThan(10_000);

      jobs.create({ id: "stale", kind: "media" });
      const staleLease = jobs.acquire("stale", "w", t, ttl)!;
      let thief: { jobId: string; lease: Lease } | undefined;
      calls.push(async () => {
        // The stale worker's request stalls past its lease; a new owner takes the entry over and
        // keeps the partial (a transient 503 records progress without resetting it).
        t += ttl + 1;
        const jobId = how === "the same job reacquired" ? "stale" : "thief";
        if (jobId === "thief") ref.jobs!.create({ id: jobId, kind: "media" });
        const lease = ref.jobs!.acquire(jobId, "thief", t, 60_000);
        expect(lease).not.toBeNull();
        thief = { jobId, lease: lease! };
        calls.unshift(async () => new Response(null, { status: 503 }));
        expect(await ref.media!.download(d.id, { jobs: ref.jobs!, ...thief })).toBe("interrupted");
        return resetResponse(kept.length);
      });

      expect(await media.download(d.id, { jobs, jobId: "stale", lease: staleLease })).toBe(
        "lease_lost",
      );
      expect(calls).toEqual([]);
      // The new owner holds the partial in its own file; the stale worker's file is gone.
      expect(readFileSync(partOf(db, d.id)).equals(kept)).toBe(true);
      expect(files(join(root, "tmp"))).toHaveLength(1);
      expect(
        db
          .prepare(
            `SELECT state, bytes_received, total_bytes, etag, error, claim_job_id, claim_generation
             FROM media_download WHERE id = ?`,
          )
          .get(d.id),
      ).toEqual({
        state: "pending",
        bytes_received: kept.length,
        total_bytes: 10_000,
        etag: '"v1"',
        error: "http 503",
        claim_job_id: thief!.jobId,
        claim_generation: thief!.lease.generation,
      });

      // The new owner resumes from the surviving partial.
      ranged = [];
      expect(await media.download(d.id, { jobs, ...thief! })).toBe("complete");
      expect(ranged).toEqual([`bytes=${kept.length}-`]);
      expect(media.blob(sha(blobA))?.sizeBytes).toBe(10_000);
    },
  );

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

// Sol review of 532a58f: each case reproduces a defect that let a download publish wrong bytes or
// claim completion it could not prove. The fix gives every execution attempt its own part file and
// an exclusive claim token, so stale async file I/O can only touch that attempt's own file.
describe("download integrity (MED-01, CAP-03 fencing)", () => {
  /** A promise gate: `arrived` resolves when the gated call is reached; `release` lets it go. */
  const gate = () => {
    let arrive!: () => void;
    let release!: () => void;
    const arrived = new Promise<void>((r) => (arrive = r));
    const opened = new Promise<void>((r) => (release = r));
    return { arrived, arrive, release, wait: () => opened };
  };
  const blobFile = (hash: string) => join(root, "blobs", hash.slice(0, 2), hash);

  it("rejects a 206 whose validator changed and never joins two representations", async () => {
    const { media, dl, db } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    dropAfter = 4_000;
    expect(await dl(d.id)).toBe("interrupted");
    dropAfter = null;
    const have = media.getDownload(d.id).bytesReceived;
    handler = (req, res) => {
      if (!req.headers.range) return false;
      res
        .writeHead(206, {
          etag: '"v2"',
          "content-length": 10_000 - have,
          "content-range": `bytes ${have}-9999/10000`,
        })
        .end(blobB.subarray(have));
      return true;
    };
    expect(await dl(d.id)).toBe("interrupted");
    expect(media.getDownload(d.id)).toMatchObject({
      state: "pending",
      bytesReceived: 0,
      error: "validator changed",
    });
    expect(db.prepare("SELECT COUNT(*) n FROM blob").get()).toEqual({ n: 0 });
    handler = null;
    expect(await dl(d.id)).toBe("complete");
    expect(media.blob(sha(blobA))?.sizeBytes).toBe(10_000);
  });

  it("never completes from a 206 whose representation length is unknown (bytes a-b/*)", async () => {
    const { media, dl, db } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    let partials = 0;
    handler = (req, res) => {
      const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
      if (!m) {
        // No Content-Length: the representation length is never learned from the first response.
        res.writeHead(200, { etag: '"v1"' });
        res.write(blobA.subarray(0, 4_000));
        setTimeout(() => res.destroy(), 20);
        return true;
      }
      const start = Number(m[1]);
      if (start >= blobA.length) {
        res.writeHead(416, { "content-range": `bytes */${blobA.length}` }).end();
        return true;
      }
      partials++;
      const end = Math.min(start + 1_999, blobA.length - 1);
      res
        .writeHead(206, {
          etag: '"v1"',
          "content-length": end - start + 1,
          "content-range": `bytes ${start}-${end}/*`,
        })
        .end(blobA.subarray(start, end + 1));
      return true;
    };
    expect(await dl(d.id)).toBe("interrupted");
    expect(media.getDownload(d.id)).toMatchObject({ totalBytes: null });
    expect(media.getDownload(d.id).bytesReceived).toBeGreaterThan(0);
    expect(await dl(d.id)).toBe("interrupted");
    expect(partials).toBeGreaterThan(1); // it asked for more instead of stopping at the first range
    expect(partials).toBeLessThanOrEqual(32);
    expect(media.getDownload(d.id).state).toBe("pending");
    expect(db.prepare("SELECT COUNT(*) n FROM blob").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM media").get()).toEqual({ n: 0 });
  });

  it("rejects a 206 with unknown total that ends past the saved representation length", async () => {
    const appends: string[] = [];
    const { media, dl, db } = setup({
      fs: {
        open: (p, flags) => {
          if (flags === "a") appends.push(String(p));
          return realFs.open(p, flags);
        },
      },
    });
    const d = media.enqueue("s1", `${base}/x`);
    handler = (req, res) => {
      if (!req.headers.range) {
        res.writeHead(200, { etag: '"v1"', "content-length": 8 });
        res.write("AAAA");
        setTimeout(() => res.destroy(), 20);
        return true;
      }
      res
        .writeHead(206, {
          etag: '"v1"',
          "content-length": 6,
          "content-range": "bytes 4-9/*",
        })
        .end("BBBBBB");
      return true;
    };
    expect(await dl(d.id)).toBe("interrupted");
    expect(media.getDownload(d.id)).toMatchObject({ bytesReceived: 4, totalBytes: 8 });
    expect(await dl(d.id)).toBe("interrupted");
    expect(appends).toEqual([]); // rejected before any file I/O
    expect(media.getDownload(d.id)).toMatchObject({
      state: "pending",
      bytesReceived: 0,
      error: "invalid content-range",
      mediaId: null,
    });
    expect(db.prepare("SELECT COUNT(*) n FROM blob").get()).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM media").get()).toEqual({ n: 0 });
  });

  it("rejects a 206 range end that is not a safe integer before any file I/O", async () => {
    const appends: string[] = [];
    const { media, dl } = setup({
      fs: {
        open: (p, flags) => {
          if (flags === "a") appends.push(String(p));
          return realFs.open(p, flags);
        },
      },
    });
    const d = media.enqueue("s1", `${base}/x`);
    handler = (req, res) => {
      if (!req.headers.range) {
        res.writeHead(200, { etag: '"v1"' }); // unknown length: no saved total to bound the range
        res.write("AAAA");
        setTimeout(() => res.destroy(), 20);
        return true;
      }
      res
        .writeHead(206, { etag: '"v1"', "content-range": "bytes 4-9007199254740993/*" })
        .end("BBBB");
      return true;
    };
    expect(await dl(d.id)).toBe("interrupted");
    expect(media.getDownload(d.id)).toMatchObject({ bytesReceived: 4, totalBytes: null });
    expect(await dl(d.id)).toBe("interrupted");
    expect(appends).toEqual([]);
    expect(media.getDownload(d.id)).toMatchObject({
      state: "pending",
      bytesReceived: 0,
      error: "invalid content-range",
    });
  });

  it("rejects a 206 complete length that is not a safe integer", async () => {
    const { media, dl } = setup();
    const d = media.enqueue("s1", `${base}/x`);
    handler = (req, res) => {
      if (!req.headers.range) {
        res.writeHead(200, { etag: '"v1"' });
        res.write("AAAA");
        setTimeout(() => res.destroy(), 20);
        return true;
      }
      res
        .writeHead(206, { etag: '"v1"', "content-range": "bytes 4-7/99999999999999999999" })
        .end("BBBB");
      return true;
    };
    expect(await dl(d.id)).toBe("interrupted");
    expect(await dl(d.id)).toBe("interrupted");
    expect(media.getDownload(d.id)).toMatchObject({
      state: "pending",
      bytesReceived: 0,
      totalBytes: null,
      error: "invalid content-range",
    });
  });

  it("rejects a 206 whose exclusive range end overflows a safe integer", async () => {
    const appends: string[] = [];
    const { media, dl } = setup({
      fs: {
        open: (p, flags) => {
          if (flags === "a") appends.push(String(p));
          return realFs.open(p, flags);
        },
      },
    });
    const d = media.enqueue("s1", `${base}/x`);
    handler = (req, res) => {
      if (!req.headers.range) {
        res.writeHead(200, { etag: '"v1"' });
        res.write("AAAA");
        setTimeout(() => res.destroy(), 20);
        return true;
      }
      // The last position is safe; its exclusive end (last + 1) is not.
      res
        .writeHead(206, {
          etag: '"v1"',
          "content-range": `bytes 4-${Number.MAX_SAFE_INTEGER}/*`,
        })
        .end("BBBB");
      return true;
    };
    expect(await dl(d.id)).toBe("interrupted");
    expect(await dl(d.id)).toBe("interrupted");
    expect(appends).toEqual([]);
    expect(media.getDownload(d.id)).toMatchObject({
      state: "pending",
      bytesReceived: 0,
      error: "invalid content-range",
    });
  });

  it("a stale worker's delayed open cannot truncate the new owner's partial", async () => {
    const ttl = 1_000;
    let t = 1_000;
    const g = gate();
    let first = true;
    const { media, jobs } = setup({
      leaseTtlMs: ttl,
      now: () => t,
      fs: {
        open: async (p, f) => {
          if (first) {
            first = false;
            g.arrive();
            await g.wait();
          }
          return realFs.open(p, f);
        },
      },
    });
    const d = media.enqueue("s1", `${base}/b`);
    jobs.create({ id: "j", kind: "media" });
    const old = jobs.acquire("j", "old", t, ttl)!;
    const stale = media.download(d.id, { jobs, jobId: "j", lease: old });
    await g.arrived;
    t += ttl + 1;
    const lease = jobs.acquire("j", "new", t, 60_000)!;
    dropAfter = 4_000;
    expect(await media.download(d.id, { jobs, jobId: "j", lease })).toBe("interrupted");
    const kept = media.getDownload(d.id).bytesReceived;
    expect(kept).toBeGreaterThan(0);
    g.release();
    expect(await stale).toBe("lease_lost");
    dropAfter = null;
    ranged = [];
    expect(await media.download(d.id, { jobs, jobId: "j", lease })).toBe("complete");
    expect(ranged).toEqual([`bytes=${kept}-`]);
    expect(readFileSync(blobFile(sha(blobB))).equals(blobB)).toBe(true);
  });

  it("a stale in-flight write cannot change the new owner's committed blob", async () => {
    const ttl = 1_000;
    let t = 1_000;
    const g = gate();
    let first = true;
    const { media, jobs, db } = setup({
      leaseTtlMs: ttl,
      now: () => t,
      fs: {
        write: async (h, c) => {
          if (first) {
            first = false;
            g.arrive();
            await g.wait();
          }
          return h.write(c);
        },
      },
    });
    const d = media.enqueue("s1", `${base}/a`);
    jobs.create({ id: "j", kind: "media" });
    const old = jobs.acquire("j", "old", t, ttl)!;
    const stale = media.download(d.id, { jobs, jobId: "j", lease: old });
    await g.arrived;
    t += ttl + 1;
    const lease = jobs.acquire("j", "new", t, 60_000)!;
    handler = (req, res) => {
      if (req.url !== "/a") return false;
      res.writeHead(200, { "content-length": 10_000, etag: '"v2"' }).end(blobB);
      return true;
    };
    expect(await media.download(d.id, { jobs, jobId: "j", lease })).toBe("complete");
    expect(readFileSync(blobFile(sha(blobB))).equals(blobB)).toBe(true);
    g.release();
    expect(await stale).toBe("lease_lost");
    expect(readFileSync(blobFile(sha(blobB))).equals(blobB)).toBe(true);
    expect(db.prepare("SELECT content_hash h, ref_count r FROM blob").all()).toEqual([
      { h: sha(blobB), r: 1 },
    ]);
    expect(files(join(root, "tmp"))).toEqual([]);
  });

  it("excludes a second concurrent attempt under the same retained lease", async () => {
    const g = gate();
    let opens = 0;
    const { media, jobs, clock } = setup({
      fs: {
        open: async (p, f) => {
          opens++;
          if (opens === 1) {
            g.arrive();
            await g.wait();
          }
          return realFs.open(p, f);
        },
      },
    });
    const d = media.enqueue("s1", `${base}/a`);
    jobs.create({ id: "j", kind: "media" });
    const ctx = { jobs, jobId: "j", lease: jobs.acquire("j", "w", clock.now(), 60_000)! };
    const first = media.download(d.id, ctx);
    await g.arrived;
    expect(await media.download(d.id, ctx)).toBe("claimed");
    g.release();
    expect(await first).toBe("complete");
    expect(opens).toBe(1);
    expect(requests).toEqual(["/a"]);
    // The claim is released when the attempt ends, so the same lease can run the entry again.
    const e = media.enqueue("s1", `${base}/b`);
    expect(await media.download(e.id, ctx)).toBe("complete");
  });

  it("verifies an existing blob before deduplicating and repairs a corrupt one", async () => {
    const { media, dl } = setup();
    const dest = blobFile(sha(blobA));
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, Buffer.alloc(10_000, 1)); // same size, wrong bytes
    const d = media.enqueue("s1", `${base}/a`);
    expect(await dl(d.id)).toBe("complete");
    expect(readFileSync(dest).equals(blobA)).toBe(true);
    expect(media.blob(sha(blobA))).toMatchObject({ sizeBytes: 10_000, refCount: 1 });
    expect(files(join(root, "tmp"))).toEqual([]);
  });

  it("finishes short file writes by honoring bytesWritten", async () => {
    const { media, dl } = setup({
      fs: {
        write: (h, c) => (h as realFs.FileHandle).write(c.subarray(0, Math.ceil(c.length / 2))),
      },
    });
    handler = (_req, res) => {
      res.writeHead(200, { etag: '"v1"' }); // unknown length: only the write count can catch it
      res.end(blobA);
      return true;
    };
    const d = media.enqueue("s1", `${base}/x`);
    expect(await dl(d.id)).toBe("complete");
    expect(media.blob(sha(blobA))?.sizeBytes).toBe(10_000);
  });

  it.each([
    ["reports zero progress", (h: realFs.FileHandle, c: Uint8Array) => h.write(c.subarray(0, 0))],
    [
      "silently writes half",
      async (h: realFs.FileHandle, c: Uint8Array) => {
        await h.write(c.subarray(0, Math.ceil(c.length / 2)));
      },
    ],
  ])("never completes when a file write %s", async (_why, write) => {
    const { media, dl, db } = setup({
      fs: { write: (h, c) => write(h as realFs.FileHandle, c) },
    });
    handler = (_req, res) => {
      res.writeHead(200, { etag: '"v1"' });
      res.end(blobA);
      return true;
    };
    const d = media.enqueue("s1", `${base}/x`);
    expect(await dl(d.id)).toBe("interrupted");
    expect(media.getDownload(d.id)).toMatchObject({ state: "pending", bytesReceived: 0 });
    expect(db.prepare("SELECT COUNT(*) n FROM blob").get()).toEqual({ n: 0 });
  });

  it("counts legacy media rows as references and links the download to the legacy row", async () => {
    const db = new Database(":memory:");
    migrate(db, { migrations: MIGRATIONS.slice(0, 4) });
    db.prepare("INSERT INTO source (id, source_type) VALUES ('s1', 'post'), ('s2', 'post')").run();
    const insert = db.prepare(
      "INSERT INTO media (source_id, content_hash, blob_path) VALUES (?, ?, ?)",
    );
    const h = sha(blobA);
    insert.run("s1", h, "legacy/a");
    insert.run("s1", h, "legacy/a-copy"); // a legacy duplicate is kept
    insert.run("s2", h, null); // another source shares the content
    let backup: Buffer | undefined;
    expect(migrate(db, { backup: () => void (backup = db.serialize()) })).toEqual({
      applied: [5],
      version: 5,
    });
    expect(backup?.length).toBeGreaterThan(0);
    const media = new MediaStore(db, {
      root,
      budgetBytes: 1_000_000,
      minFreeBytes: 0,
      freeBytes: () => 10_000_000,
      fetch: testFetch,
      now: () => 1_000,
    });
    const jobs = new JobStore(db);
    jobs.create({ id: "j", kind: "media" });
    const lease = jobs.acquire("j", "w", 1_000, 60_000)!;
    const d = media.enqueue("s1", `${base}/a`);
    expect(await media.download(d.id, { jobs, jobId: "j", lease })).toBe("complete");
    expect(media.blob(h)).toMatchObject({ sizeBytes: 10_000, refCount: 3 });
    const rows = db.prepare("SELECT id, source_id, blob_path FROM media ORDER BY id").all();
    expect(rows).toEqual([
      { id: 1, source_id: "s1", blob_path: `blobs/${h.slice(0, 2)}/${h}` },
      { id: 2, source_id: "s1", blob_path: "legacy/a-copy" },
      { id: 3, source_id: "s2", blob_path: null },
    ]);
    expect(media.getDownload(d.id).mediaId).toBe(1);
    media.release(h);
    media.release(h);
    media.release(h);
    expect(media.unreferenced()).toEqual([h]);
  });
});
