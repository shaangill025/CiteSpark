import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  JobStore,
  MediaStore,
  defaultMediaBudget,
  migrate,
  type MediaStoreOptions,
} from "./index.ts";

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const blobA = Buffer.alloc(10_000, 7);
const blobB = Buffer.alloc(10_000, 9);

let server: Server;
let base: string;
let root: string;
let dropAfter: number | null;
let ranged: string[];

beforeEach(async () => {
  dropAfter = null;
  ranged = [];
  root = mkdtempSync(join(tmpdir(), "citspark-media-"));
  server = createServer((req, res) => {
    const body = req.url === "/a" || req.url === "/a-dup" ? blobA : req.url === "/b" ? blobB : null;
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

const setup = (opts: Partial<MediaStoreOptions> = {}) => {
  const db = new Database(":memory:");
  migrate(db);
  db.prepare("INSERT INTO source (id, source_type) VALUES ('s1', 'post'), ('s2', 'post')").run();
  const media = new MediaStore(db, {
    root,
    budgetBytes: 1_000_000,
    minFreeBytes: 0,
    freeBytes: () => 10_000_000,
    ...opts,
  });
  return { db, media, jobs: new JobStore(db) };
};
const files = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true, withFileTypes: true })
        .filter((e) => e.isFile())
        .map((e) => e.name)
    : [];

describe("content-addressed blobs and reference counts (MED-01)", () => {
  it("stores a download under its sha256 and records size, mime and ref count", async () => {
    const { media, db } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    expect(await media.download(d.id)).toBe("complete");
    const row = db.prepare("SELECT * FROM media").get() as Record<string, unknown>;
    expect(row["content_hash"]).toBe(sha(blobA));
    expect(row["mime_type"]).toBe("image/png");
    expect(readFileSync(join(root, row["blob_path"] as string))).toEqual(blobA);
    expect(media.blob(sha(blobA))).toMatchObject({ sizeBytes: 10_000, refCount: 1 });
    expect(files(join(root, "tmp"))).toEqual([]);
  });

  it("deduplicates identical bytes and counts references", async () => {
    const { media } = setup();
    await media.download(media.enqueue("s1", `${base}/a`).id);
    await media.download(media.enqueue("s2", `${base}/a-dup`).id);
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

  it("enqueue is idempotent per source and url, and rejects non-http urls", () => {
    const { media } = setup();
    const a = media.enqueue("s1", `${base}/a`);
    expect(media.enqueue("s1", `${base}/a`).id).toBe(a.id);
    expect(() => media.enqueue("s1", "file:///etc/passwd")).toThrow(/http/);
  });

  it("marks a missing remote file failed without a blob", async () => {
    const { media } = setup();
    const d = media.enqueue("s1", `${base}/missing`);
    expect(await media.download(d.id)).toBe("failed");
    expect(media.getDownload(d.id).state).toBe("failed");
    expect(media.usedBytes()).toBe(0);
  });
});

describe("resumable downloads (MED-01)", () => {
  it("keeps the partial file when the connection drops and resumes with a Range request", async () => {
    const { media } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    dropAfter = 4_000;
    expect(await media.download(d.id)).toBe("interrupted");
    const partial = media.getDownload(d.id);
    expect(partial.state).toBe("pending");
    expect(partial.bytesReceived).toBeGreaterThan(0);
    expect(partial.bytesReceived).toBeLessThan(10_000);
    expect(statSync(join(root, "tmp", `${d.id}.part`)).size).toBe(partial.bytesReceived);

    expect(await media.download(d.id)).toBe("complete");
    expect(ranged).toEqual([`bytes=${partial.bytesReceived}-`]);
    expect(media.blob(sha(blobA))?.sizeBytes).toBe(10_000);
  });

  it("discards a stale partial when the server ignores Range and sends the whole body", async () => {
    const { media } = setup();
    const d = media.enqueue("s1", `${base}/a`);
    dropAfter = 3_000;
    await media.download(d.id);
    dropAfter = null;
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      res.writeHead(200, { "content-length": blobA.length }).end(blobA);
    });
    expect(await media.download(d.id)).toBe("complete");
    expect(media.blob(sha(blobA))?.sizeBytes).toBe(10_000);
  });
});

describe("media budget (MED-04, Q28)", () => {
  it("pauses new media at the limit, keeps queued entries, evicts nothing, and text continues", async () => {
    const { media } = setup({ budgetBytes: 15_000 });
    const first = media.enqueue("s1", `${base}/a`);
    const second = media.enqueue("s1", `${base}/b`);
    expect(await media.download(first.id)).toBe("complete");
    expect(await media.download(second.id)).toBe("paused_budget");
    expect(media.getDownload(second.id).state).toBe("paused_budget");
    expect(media.usedBytes()).toBeLessThanOrEqual(15_000);
    expect(media.blob(sha(blobA))).toBeDefined();
    expect(existsSync(join(root, "blobs"))).toBe(true);
    expect(media.status()).toMatchObject({ mediaPaused: true, textWritesAllowed: true });
  });

  it("stops mid-stream when an unknown-length body would cross the limit", async () => {
    const { media } = setup({ budgetBytes: 4_000 });
    server.removeAllListeners("request");
    server.on("request", (_req, res) => {
      res.writeHead(200);
      res.write(blobA);
      res.end();
    });
    const d = media.enqueue("s1", `${base}/chunked`);
    expect(await media.download(d.id)).toBe("paused_budget");
    expect(media.usedBytes()).toBeLessThanOrEqual(4_000);
  });

  it("resumes once the user raises the budget", async () => {
    const { media } = setup({ budgetBytes: 5_000 });
    const d = media.enqueue("s1", `${base}/a`);
    expect(await media.download(d.id)).toBe("paused_budget");
    media.setBudget(50_000);
    expect(await media.download(d.id)).toBe("complete");
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
    const { media } = setup({ minFreeBytes: 1_000_000, freeBytes: () => free });
    const d = media.enqueue("s1", `${base}/a`);
    free = 500_000;
    expect(await media.download(d.id)).toBe("paused_disk");
    expect(media.status()).toMatchObject({ mediaPaused: true, textWritesAllowed: false });
    expect(files(join(root, "blobs"))).toEqual([]);
    free = 10_000_000;
    expect(media.status().textWritesAllowed).toBe(true);
    expect(await media.download(d.id)).toBe("complete");
  });

  it("treats a simulated ENOSPC write as disk full and latches until space is rechecked", async () => {
    let full = true;
    const { media } = setup({
      writeChunk: async () => {
        if (full) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      },
    });
    const d = media.enqueue("s1", `${base}/a`);
    expect(await media.download(d.id)).toBe("paused_disk");
    expect(media.status().textWritesAllowed).toBe(false);
    expect(media.getDownload(d.id).state).toBe("paused_disk");
    full = false;
    expect(media.status().textWritesAllowed).toBe(false);
    media.recheckDisk();
    expect(media.status().textWritesAllowed).toBe(true);
  });
});

describe("download job on the job store (CAP-04 lease)", () => {
  const nowMs = 1_000;
  it("completes the job after downloading every entry", async () => {
    const { media, jobs } = setup();
    jobs.create({ id: "j1", kind: "media" });
    media.enqueue("s1", `${base}/a`);
    media.enqueue("s2", `${base}/b`);
    expect(await media.runJob(jobs, "j1", "w", nowMs)).toBe("complete");
    expect(jobs.get("j1").state).toBe("complete");
    expect(media.usedBytes()).toBe(20_000);
  });

  it("pauses the job on budget, keeps pending entries, and finishes after resume with more budget", async () => {
    const { media, jobs } = setup({ budgetBytes: 15_000 });
    jobs.create({ id: "j1", kind: "media" });
    media.enqueue("s1", `${base}/a`);
    const b = media.enqueue("s1", `${base}/b`);
    expect(await media.runJob(jobs, "j1", "w", nowMs)).toBe("paused");
    expect(jobs.get("j1")).toMatchObject({ state: "paused", stopReason: "media budget reached" });
    expect(media.getDownload(b.id).state).toBe("paused_budget");
    media.setBudget(100_000);
    jobs.resume("j1");
    expect(await media.runJob(jobs, "j1", "w", nowMs + 10)).toBe("complete");
    expect(media.blob(sha(blobB))).toBeDefined();
  });

  it("marks the job partial when a download is interrupted and completes after resume", async () => {
    const { media, jobs } = setup();
    jobs.create({ id: "j1", kind: "media" });
    media.enqueue("s1", `${base}/a`);
    dropAfter = 2_000;
    expect(await media.runJob(jobs, "j1", "w", nowMs)).toBe("partial");
    dropAfter = null;
    jobs.resume("j1");
    expect(await media.runJob(jobs, "j1", "w", nowMs + 10)).toBe("complete");
    expect(media.blob(sha(blobA))?.refCount).toBe(1);
  });

  it("pauses the job on disk pressure", async () => {
    const { media, jobs } = setup({ minFreeBytes: 1, freeBytes: () => 0 });
    jobs.create({ id: "j1", kind: "media" });
    media.enqueue("s1", `${base}/a`);
    expect(await media.runJob(jobs, "j1", "w", nowMs)).toBe("paused");
    expect(jobs.get("j1").stopReason).toBe("disk space low");
  });

  it("returns false when the job lease is held elsewhere", async () => {
    const { media, jobs } = setup();
    jobs.create({ id: "j1", kind: "media" });
    jobs.acquire("j1", "other", nowMs, 60_000);
    expect(await media.runJob(jobs, "j1", "w", nowMs + 1)).toBe("not_acquired");
  });
});
