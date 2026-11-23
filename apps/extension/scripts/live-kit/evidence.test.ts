// Synthetic proof that the evidence exporter leaves out sensitive fields and that the scanner gate
// fails on a planted canary (SEC-04, B8). All data here is synthetic.
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { migrate } from "@citspark/store";
import {
  buildEvidence,
  checkEvidenceShape,
  errorCodesOf,
  sanitizeStop,
  writeEvidenceGated,
  type Evidence,
} from "./evidence.ts";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

// Strings that must never reach the evidence file.
const HANDLE = "@secret_handle_zq";
const ACCOUNT = "acct-4815162342-zq";
const POST_TEXT = "my private post text about zebras";
const URL_ID = "https://x.com/someone/status/1234567890123456789";
const CURSOR = "DAACCgACGZcursorsecretvalue";
const OPAQUE = "5eed1234abcd9876";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "cs-evidence-"));
  temps.push(dir);
  const libraryDir = join(dir, "library");
  mkdirSync(libraryDir);
  const libraryPath = join(libraryDir, "library.sqlite");
  const db = new Database(libraryPath);
  migrate(db);
  const job = db.prepare(
    "INSERT INTO job (id, kind, state, account_id, collection_id, cursor, retry_count, stop_reason, checkpoint) VALUES (?, 'x-capture', ?, ?, ?, ?, ?, ?, ?)",
  );
  job.run(
    "job-1",
    "paused",
    ACCOUNT,
    "bookmarks",
    CURSOR,
    1,
    `pass ${OPAQUE} paused by user at ${URL_ID}`,
    JSON.stringify({ pass: OPAQUE, gaps: 2, cursor: CURSOR }),
  );
  job.run(
    "job-2",
    "failed",
    ACCOUNT,
    "bookmark_folder:" + OPAQUE,
    null,
    0,
    "checkpoint_corrupt rate_limited",
    null,
  );
  db.prepare(
    "INSERT INTO capture_pass (job_id, pass_id, cursor, pages, started_at, ended_at) VALUES ('job-1', 'p1', ?, 2, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:10.000Z')",
  ).run(CURSOR);
  const page = db.prepare(
    "INSERT INTO capture_page (job_id, pass_id, seq, page_key, cursor_in, cursor_out, content_hash, record_count, new_records, adapter_id, adapter_version, committed_at) VALUES ('job-1','p1',?,?,?,?,?,?,?,'x-bookmarks','1.0.0',?)",
  );
  page.run(1, "k1", null, CURSOR, "h1", 20, 20, "2026-01-01T00:00:02.000Z");
  page.run(2, "k2", CURSOR, CURSOR, "h2", 18, 15, "2026-01-01T00:00:08.000Z");
  db.close();
  const transitionsPath = join(dir, "transitions.jsonl");
  writeFileSync(
    transitionsPath,
    [
      { t: "2026-01-01T00:00:00.000Z", job: 1, state: "running", stop: "" },
      { t: "2026-01-01T00:00:10.500Z", job: 1, state: "paused", stop: `user_pause ${URL_ID}` },
      { t: "2026-01-01T00:01:00.000Z", job: 1, state: "running", stop: "" },
      { t: "2026-01-01T00:02:00.000Z", job: 2, state: "failed", stop: "checkpoint_corrupt" },
      { handle: HANDLE },
    ]
      .map((x) => JSON.stringify(x))
      .join("\n") +
      "\nnot json " +
      POST_TEXT +
      "\n",
  );
  return { dir, libraryDir, libraryPath, transitionsPath };
}

const build = (f: ReturnType<typeof fixture>): Evidence =>
  buildEvidence({
    libraryPath: f.libraryPath,
    transitionsPath: f.transitionsPath,
    browser: { name: "Google Chrome", version: "130.0.6723.92" },
    extensionVersion: "0.1.0",
    os: { platform: "darwin", release: "25.1.0", arch: "arm64" },
    nodeVersion: "v24.0.0",
    commit: "abc1234",
    now: new Date("2026-01-02T00:00:00Z"),
  });

describe("evidence exporter", () => {
  test("reports counts, states, timings and error codes", () => {
    const e = build(fixture());
    expect(e.totals).toMatchObject({ jobs: 2, pages: 2, records: 38, gaps: 2 });
    expect(e.jobs[0]).toMatchObject({
      collection: "bookmarks",
      state: "paused",
      passes: 1,
      pages: 2,
      records: 38,
      newRecords: 35,
      gaps: 2,
      runsStarted: 2,
      durationMs: 6000,
      adapters: ["x-bookmarks@1.0.0"],
    });
    expect(e.jobs[0]!.passDetail).toEqual([{ pass: 1, pages: 2, records: 38, durationMs: 10000 }]);
    expect(e.jobs[1]).toMatchObject({ collection: "bookmark_folder", state: "failed" });
    expect(e.errorCodes).toEqual(["checkpoint_corrupt", "rate_limited"]);
    expect(e.transitions.map((t) => [t.atMs, t.job, t.state])).toEqual([
      [0, 1, "running"],
      [10500, 1, "paused"],
      [60000, 1, "running"],
      [120000, 2, "failed"],
    ]);
  });

  test("excludes cookies, tokens, handles, account IDs, post text, cursors and URLs", () => {
    const f = fixture();
    const out = join(f.dir, "evidence.json");
    const gate = writeEvidenceGated({
      evidence: build(f),
      outPath: out,
      scanPaths: [f.libraryDir, f.transitionsPath],
      canaries: [],
    });
    expect(gate).toEqual({ ok: true, problems: [], findings: [] });
    const text = readFileSync(out, "utf8");
    for (const s of [
      HANDLE,
      ACCOUNT,
      POST_TEXT,
      URL_ID,
      "status/",
      "x.com",
      CURSOR,
      OPAQUE,
      "job-1",
      "p1",
      "k1",
    ]) {
      expect(text, s).not.toContain(s);
    }
    expect(checkEvidenceShape(JSON.parse(text))).toEqual([]);
  });

  test("stop reasons keep only a closed vocabulary; IDs, URLs and handles are dropped", () => {
    expect(sanitizeStop(`pass ${OPAQUE} paused by user at ${URL_ID}`)).toBe("other");
    expect(sanitizeStop("user_pause")).toBe("user_pause");
    expect(sanitizeStop(`account mismatch: job ${ACCOUNT} is bound to ${HANDLE}`)).toBe(
      "account_mismatch",
    );
    expect(sanitizeStop("recognized end: abc123")).toBe("recognized_end");
    expect(errorCodesOf("failed: checkpoint_corrupt (rate_limited)")).toEqual([
      "checkpoint_corrupt",
      "rate_limited",
    ]);
    expect(errorCodesOf("user_pause")).toEqual([]);
    expect(sanitizeStop(null)).toBe("");
  });

  test("the shape check rejects handles, URLs, long IDs and credential-named keys", () => {
    expect(checkEvidenceShape({ a: "@someone" })).toHaveLength(1);
    expect(checkEvidenceShape({ a: "see https://x.com/a" })).toHaveLength(1);
    expect(checkEvidenceShape({ a: "1234567890123456789" })).toHaveLength(1);
    expect(checkEvidenceShape({ authToken: "x" }).length).toBeGreaterThan(0);
    expect(checkEvidenceShape({ cookie: "x" }).length).toBeGreaterThan(0);
  });
});

describe("scanner gate", () => {
  test("fails (and deletes the evidence file) on a canary planted in the library directory", () => {
    const f = fixture();
    writeFileSync(join(f.libraryDir, "stray.log"), "request headers: ct0=deadbeefdeadbeef\n");
    const out = join(f.dir, "evidence.json");
    const gate = writeEvidenceGated({
      evidence: build(f),
      outPath: out,
      scanPaths: [f.libraryDir],
      canaries: [],
    });
    expect(gate.ok).toBe(false);
    expect(gate.findings.length).toBeGreaterThan(0);
    expect(existsSync(out)).toBe(false);
  });

  test("fails on a caller-supplied canary inside the SQLite file bytes", () => {
    const f = fixture();
    const db = new Database(f.libraryPath);
    db.prepare("INSERT INTO job (id, kind, state) VALUES ('j9', 'other', 'queued')").run();
    db.prepare("UPDATE job SET progress = ? WHERE id = 'j9'").run("CANARY-session-value-123456");
    db.close();
    const out = join(f.dir, "evidence.json");
    const gate = writeEvidenceGated({
      evidence: build(f),
      outPath: out,
      scanPaths: [f.libraryDir],
      canaries: ["CANARY-session-value-123456"],
    });
    expect(gate.ok).toBe(false);
    expect(existsSync(out)).toBe(false);
  });

  test("fails when a credential reaches the evidence itself", () => {
    const f = fixture();
    const e = build(f);
    e.jobs[0]!.stop = "ct0=abcdef0123456789";
    const out = join(f.dir, "evidence.json");
    const gate = writeEvidenceGated({ evidence: e, outPath: out, scanPaths: [], canaries: [] });
    expect(gate.ok).toBe(false);
    expect(existsSync(out)).toBe(false);
  });
});
