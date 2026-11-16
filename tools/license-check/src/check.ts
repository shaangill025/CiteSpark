// Allowlist of SPDX identifiers compatible with an Apache-2.0 distribution (ADR 0009, Q33).
export const ALLOWED_LICENSES: ReadonlySet<string> = new Set([
  "MIT",
  "MIT-0",
  "ISC",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Apache-2.0",
  "BlueOak-1.0.0",
  "CC0-1.0",
  "CC-BY-4.0",
  "Python-2.0",
  "Unlicense",
  "MPL-2.0",
]);

export interface LicenseEntry {
  name: string;
  versions: string[];
  license: string;
}

export interface Violation {
  name: string;
  versions: string[];
  license: string;
}

// Evaluates an SPDX expression with parentheses; AND binds tighter than OR.
// Anything the parser cannot handle is rejected.
export function isAllowed(
  expression: string,
  allowed: ReadonlySet<string> = ALLOWED_LICENSES,
): boolean {
  const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
  let pos = 0;
  const parseOr = (): boolean => {
    let result = parseAnd();
    while (tokens[pos]?.toUpperCase() === "OR") {
      pos++;
      const rhs = parseAnd();
      result = result || rhs;
    }
    return result;
  };
  const parseAnd = (): boolean => {
    let result = parseAtom();
    while (tokens[pos]?.toUpperCase() === "AND") {
      pos++;
      const rhs = parseAtom();
      result = result && rhs;
    }
    return result;
  };
  const parseAtom = (): boolean => {
    const token = tokens[pos++];
    if (token === undefined || token === ")" || /^(AND|OR)$/i.test(token)) throw new Error("bad");
    if (token === "(") {
      const inner = parseOr();
      if (tokens[pos++] !== ")") throw new Error("bad");
      return inner;
    }
    return allowed.has(token);
  };
  try {
    const result = parseOr();
    return pos === tokens.length && result;
  } catch {
    return false;
  }
}

export function findViolations(
  entries: readonly LicenseEntry[],
  allowed: ReadonlySet<string> = ALLOWED_LICENSES,
): Violation[] {
  return entries
    .filter((e) => !isAllowed(e.license, allowed))
    .map(({ name, versions, license }) => ({ name, versions, license }));
}

// `pnpm licenses list --json` groups packages by license name. Versions may be
// plain strings or "name@version" specifiers depending on the pnpm version.
export function flattenPnpmLicenses(
  raw: Record<string, (Partial<LicenseEntry> | string)[]>,
): LicenseEntry[] {
  return Object.entries(raw).flatMap(([license, pkgs]) =>
    pkgs.map((p): LicenseEntry => {
      if (typeof p === "string") {
        const at = p.lastIndexOf("@");
        return at > 0
          ? { name: p.slice(0, at), versions: [p.slice(at + 1)], license }
          : { name: p, versions: [], license };
      }
      return { name: p.name ?? "unknown", versions: p.versions ?? [], license };
    }),
  );
}
