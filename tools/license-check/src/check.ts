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

// Evaluates an SPDX expression: OR needs one allowed branch, AND needs all.
export function isAllowed(
  expression: string,
  allowed: ReadonlySet<string> = ALLOWED_LICENSES,
): boolean {
  const cleaned = expression.replace(/[()]/g, " ").trim();
  if (cleaned === "") return false;
  return cleaned
    .split(/\s+OR\s+/i)
    .some((alt) => alt.split(/\s+AND\s+/i).every((id) => allowed.has(id.trim())));
}

export function findViolations(
  entries: readonly LicenseEntry[],
  allowed: ReadonlySet<string> = ALLOWED_LICENSES,
): Violation[] {
  return entries
    .filter((e) => !isAllowed(e.license, allowed))
    .map(({ name, versions, license }) => ({ name, versions, license }));
}

// `pnpm licenses list --json` groups packages by license name.
export function flattenPnpmLicenses(raw: Record<string, LicenseEntry[]>): LicenseEntry[] {
  return Object.entries(raw).flatMap(([license, pkgs]) => pkgs.map((p) => ({ ...p, license })));
}
