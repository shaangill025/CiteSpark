// Credential-free evidence for the owner's live M1-08 run (B8, SEC-04). The report is built from an
// allow-list of counts, states, timings, versions and error codes. It never reads post text, handles,
// account IDs, cookies, tokens, cursors, or source URLs, and a final structural check plus the
// repo's credential scanner refuse to leave a file behind that is not clean.
import Database from "better-sqlite3";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { arch, release } from "node:os";
import { ErrorCode } from "@citspark/protocol";
import { scanForCredentials, type Finding } from "../../test/t02/scan.ts";

export interface Evidence {
  schema: "citspark-live-evidence/1";
  generatedAt: string;
  tool: { extension: string; desktopCore: string; node: string; commit: string | null };
  browser: { name: string; version: string | null };
  os: { platform: string; release: string; arch: string };
  library: { captureJobs: number; sources: number };
  jobs: EvidenceJob[];
  transitions: { atMs: number; job: number; state: string; stop: string }[];
  totals: { jobs: number; pages: number; records: number; distinctSources: number; gaps: number };
  errorCodes: string[];
}

export interface EvidenceJob {
  job: number;
  collection: string;
  state: string;
  stop: string;
  errorCodes: string[];
  retryCount: number;
  passes: number;
  pages: number;
  records: number;
  newRecords: number;
  distinctSources: number;
  gaps: number | null;
  adapters: string[];
  runsStarted: number;
  createdAt: string;
  firstPageAt: string | null;
  lastPageAt: string | null;
  durationMs: number | null;
  passDetail: { pass: number; pages: number; records: number; durationMs: number | null }[];
}

const SAFE_TOKEN = /^[a-z][a-z_]{0,31}$/;

/**
 * Stop reasons and error codes are free text in places (some messages quote account or job IDs), so
 * only a closed vocabulary survives: the protocol error codes plus the extension's stop codes.
 * Anything else becomes "other".
 */
const STOP_CODES = [
  "user_pause",
  "user_cancel",
  "tab_closed",
  "no_progress",
  "daily_budget",
  "transient_errors",
  "response_too_large",
  "unsupported_schema",
  "auth_required",
  "rate_limited",
  "desktop_unavailable",
  "account_unknown",
  "network_error",
  "no_x_tab",
  "timeout",
  "recognized_end",
] as const;
const VOCAB = new Set<string>([...STOP_CODES, ...Object.values(ErrorCode)]);
const NOT_ERRORS = new Set(["user_pause", "user_cancel", "recognized_end"]);

function codesIn(reason: string): string[] {
  const norm = reason
    .replace(/^recognized end\b/, "recognized_end")
    .replace(/^account mismatch\b/, "account_mismatch");
  return [...new Set(norm.split(/[^a-z_]+/).filter((t) => VOCAB.has(t)))];
}

/** A closed-vocabulary rendering of a stop reason; never carries IDs, URLs, handles or text. */
export function sanitizeStop(reason: string | null | undefined): string {
  if (!reason) return "";
  const c = codesIn(reason);
  return c.length > 0 ? c.join(" ") : "other";
}

export function errorCodesOf(reason: string | null | undefined): string[] {
  return reason ? codesIn(reason).filter((c) => !NOT_ERRORS.has(c)) : [];
}

const COLLECTIONS = new Set(["bookmarks", "likes"]);
export const collectionKind = (id: string | null): string =>
  id === null
    ? "none"
    : COLLECTIONS.has(id)
      ? id
      : id.startsWith("bookmark_folder:")
        ? "bookmark_folder"
        : "other";

const ms = (a: string | null, b: string | null): number | null =>
  a && b && !Number.isNaN(Date.parse(a)) && !Number.isNaN(Date.parse(b))
    ? Math.max(0, Date.parse(b) - Date.parse(a))
    : null;

interface Transition {
  t: string;
  job: number;
  state: string;
  stop: string;
}

/** Reads the transitions the desktop runner logged; malformed lines are skipped, fields re-sanitized. */
export function readTransitions(path: string): Transition[] {
  if (!existsSync(path)) return [];
  const out: Transition[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    try {
      const v = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof v["t"] === "string" &&
        !Number.isNaN(Date.parse(v["t"])) &&
        Number.isInteger(v["job"]) &&
        typeof v["state"] === "string" &&
        SAFE_TOKEN.test(v["state"])
      ) {
        out.push({
          t: v["t"],
          job: v["job"] as number,
          state: v["state"],
          stop: sanitizeStop(typeof v["stop"] === "string" ? v["stop"] : ""),
        });
      }
    } catch {
      /* skip */
    }
  }
  return out;
}

export function buildEvidence(o: {
  libraryPath: string;
  transitionsPath: string;
  browser: { name: string; version: string | null };
  extensionVersion: string;
  os: { platform: string; release: string; arch: string };
  nodeVersion: string;
  commit: string | null;
  now: Date;
}): Evidence {
  const db = new Database(o.libraryPath, { readonly: true, fileMustExist: true });
  try {
    const n = (sql: string, ...a: unknown[]): number =>
      (db.prepare(sql).get(...a) as { n: number }).n;
    const rows = db
      .prepare(
        "SELECT id, collection_id, state, stop_reason, retry_count, checkpoint, created_at FROM job WHERE kind = 'x-capture' ORDER BY rowid",
      )
      .all() as {
      id: string;
      collection_id: string | null;
      state: string;
      stop_reason: string | null;
      retry_count: number;
      checkpoint: string | null;
      created_at: string;
    }[];
    const transitions = readTransitions(o.transitionsPath);
    const t0 = transitions[0] ? Date.parse(transitions[0].t) : 0;
    const jobs: EvidenceJob[] = rows.map((r, i) => {
      const page = db
        .prepare(
          "SELECT COUNT(*) pages, COALESCE(SUM(record_count),0) records, COALESCE(SUM(new_records),0) news, MIN(committed_at) first, MAX(committed_at) last FROM capture_page WHERE job_id = ?",
        )
        .get(r.id) as {
        pages: number;
        records: number;
        news: number;
        first: string | null;
        last: string | null;
      };
      const passRows = db
        .prepare(
          `SELECT p.started_at, p.ended_at, COUNT(c.id) pages, COALESCE(SUM(c.record_count),0) records
           FROM capture_pass p LEFT JOIN capture_page c ON c.job_id = p.job_id AND c.pass_id = p.pass_id
           WHERE p.job_id = ? GROUP BY p.pass_id ORDER BY p.started_at`,
        )
        .all(r.id) as {
        started_at: string;
        ended_at: string | null;
        pages: number;
        records: number;
      }[];
      const adapters = (
        db
          .prepare(
            "SELECT DISTINCT adapter_id || '@' || adapter_version a FROM capture_page WHERE job_id = ? ORDER BY a",
          )
          .all(r.id) as { a: string }[]
      ).map((x) => x.a);
      let gaps: number | null = null;
      try {
        const c = JSON.parse(r.checkpoint ?? "null") as { gaps?: unknown } | null;
        if (c && Number.isSafeInteger(c.gaps)) gaps = c.gaps as number;
      } catch {
        gaps = null;
      }
      const ordinal = i + 1;
      return {
        job: ordinal,
        collection: collectionKind(r.collection_id),
        state: r.state,
        stop: sanitizeStop(r.stop_reason),
        errorCodes: errorCodesOf(r.stop_reason),
        retryCount: r.retry_count,
        passes: passRows.length,
        pages: page.pages,
        records: page.records,
        newRecords: page.news,
        distinctSources: n(
          "SELECT COUNT(DISTINCT source_id) n FROM observation WHERE job_id = ?",
          r.id,
        ),
        gaps,
        adapters,
        runsStarted: transitions.filter((t) => t.job === ordinal && t.state === "running").length,
        createdAt: r.created_at,
        firstPageAt: page.first,
        lastPageAt: page.last,
        durationMs: ms(page.first, page.last),
        passDetail: passRows.map((p, k) => ({
          pass: k + 1,
          pages: p.pages,
          records: p.records,
          durationMs: ms(p.started_at, p.ended_at),
        })),
      };
    });
    const codes = [...new Set(jobs.flatMap((j) => j.errorCodes))].sort();
    return {
      schema: "citspark-live-evidence/1",
      generatedAt: o.now.toISOString(),
      tool: {
        extension: o.extensionVersion,
        desktopCore: "0.0.0-dev",
        node: o.nodeVersion,
        commit: o.commit,
      },
      browser: o.browser,
      os: o.os,
      library: {
        captureJobs: jobs.length,
        sources: n("SELECT COUNT(*) n FROM source"),
      },
      jobs,
      transitions: transitions.map((t) => ({
        atMs: Date.parse(t.t) - t0,
        job: t.job,
        state: t.state,
        stop: t.stop,
      })),
      totals: {
        jobs: jobs.length,
        pages: jobs.reduce((a, j) => a + j.pages, 0),
        records: jobs.reduce((a, j) => a + j.records, 0),
        distinctSources: jobs.reduce((a, j) => a + j.distinctSources, 0),
        gaps: jobs.reduce((a, j) => a + (j.gaps ?? 0), 0),
      },
      errorCodes: codes,
    };
  } finally {
    db.close();
  }
}

const SAFE_STRING = /^[A-Za-z0-9 ._@:+\-<>]{0,64}$/;
const ISO = /^\d{4}-\d\d-\d\dT[\d:.]+Z$/;
const SCHEMA = /^citspark-live-evidence\/\d+$/;

/**
 * Structural allow-list check on the finished report: every string must be short and drawn from a
 * narrow alphabet (no URL, no whitespace-rich text, no `/`, `?`, `=`), and `@handle`-like values,
 * URLs and long digit runs (platform IDs) are rejected. Returns problems; empty means acceptable.
 */
export function checkEvidenceShape(v: unknown, path = "$"): string[] {
  if (typeof v === "string") {
    if (ISO.test(v) || SCHEMA.test(v)) return [];
    const bad = !SAFE_STRING.test(v) || /^@|https?:|\d{9,}/.test(v) || /(^|[ ])@\w/.test(v);
    return bad ? [`${path}: unsafe string`] : [];
  }
  if (Array.isArray(v)) return v.flatMap((x, i) => checkEvidenceShape(x, `${path}[${i}]`));
  if (v && typeof v === "object") {
    return Object.entries(v).flatMap(([k, x]) => [
      ...(/cookie|token|csrf|auth|secret|password|handle|text|url|cursor|account/i.test(k)
        ? [`${path}.${k}: forbidden key`]
        : []),
      ...checkEvidenceShape(x, `${path}.${k}`),
    ]);
  }
  return [];
}

export interface GateResult {
  ok: boolean;
  problems: string[];
  findings: Finding[];
}

/** Writes the report, then gates it. On any problem the file is deleted and `ok` is false. */
export function writeEvidenceGated(o: {
  evidence: Evidence;
  outPath: string;
  scanPaths: string[];
  canaries: string[];
}): GateResult {
  const problems = checkEvidenceShape(o.evidence);
  writeFileSync(o.outPath, JSON.stringify(o.evidence, null, 2) + "\n");
  const findings = scanForCredentials([o.outPath, ...o.scanPaths], o.canaries);
  const ok = problems.length === 0 && findings.length === 0;
  if (!ok) rmSync(o.outPath, { force: true });
  return { ok, problems, findings };
}

export function gitCommit(repoRoot: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

export const osInfo = (platform: string) => ({ platform, release: release(), arch: arch() });
