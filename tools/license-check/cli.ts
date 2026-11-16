import { execFileSync } from "node:child_process";
import { findViolations, flattenPnpmLicenses, type LicenseEntry } from "./src/check.ts";

const out = execFileSync("pnpm", ["licenses", "list", "--json"], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  shell: process.platform === "win32",
});
const violations = findViolations(
  flattenPnpmLicenses(JSON.parse(out) as Record<string, LicenseEntry[]>),
);
if (violations.length > 0) {
  console.error("License check failed. Packages outside the allowlist:");
  for (const v of violations) console.error(`  ${v.name}@${v.versions.join(",")}: ${v.license}`);
  process.exit(1);
}
console.log("License check passed.");
