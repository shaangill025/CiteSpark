// Credential-disclosure scanner (SEC-04, T02): searches stored output for cookie, bearer, and CSRF
// material. Used by the T02 browser harness over the desktop library files, the extension's
// IndexedDB and storage directories, and the harness logs.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface Finding {
  file: string;
  match: string;
}

/** Generic shapes of X session material, plus exact canaries planted by the mock X page. */
const PATTERNS: RegExp[] = [
  /\bct0=[^;\s"]+/i,
  /\bauth_token=[^;\s"]+/i,
  /\bx-csrf-token\b/i,
  /\bBearer\s+[A-Za-z0-9%._~+/-]{16,}/,
  /\bauthorization\s*[:=]\s*["']?Bearer/i,
];

function files(path: string): string[] {
  let st;
  try {
    st = statSync(path);
  } catch {
    return [];
  }
  if (st.isFile()) return [path];
  if (!st.isDirectory()) return [];
  return readdirSync(path).flatMap((n) => files(join(path, n)));
}

/** Scans every file under `paths` as bytes (latin1 and UTF-16LE views) for canaries and patterns. */
export function scanForCredentials(paths: string[], canaries: string[]): Finding[] {
  const out: Finding[] = [];
  for (const file of paths.flatMap(files)) {
    const buf = readFileSync(file);
    const views = [buf.toString("latin1"), buf.toString("utf16le")];
    for (const text of views) {
      for (const c of canaries) {
        if (c.length >= 8 && text.includes(c))
          out.push({ file, match: `canary:${c.slice(0, 6)}…` });
      }
      for (const p of PATTERNS) {
        const m = p.exec(text);
        if (m) out.push({ file, match: `pattern:${p.source.slice(0, 24)}` });
      }
    }
  }
  return out;
}
