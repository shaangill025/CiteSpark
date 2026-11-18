# Dependency audit exceptions

Requirement: SEC-06 (dependency scanning). Tracking: [issue #21](https://github.com/shaangill025/CiteSpark/issues/21).

CI's `Dependency audit` step (ubuntu job in [ci.yml](../../.github/workflows/ci.yml)) runs `pnpm audit-gate`
([tools/audit-gate](../../tools/audit-gate/cli.ts)) instead of `pnpm audit --audit-level high`. The gate runs the
full `pnpm audit --json`, prints its report unchanged, and fails on every high or critical advisory unless one
owner-approved, time-limited exception in [audit-exceptions.json](../../tools/audit-gate/audit-exceptions.json)
covers it exactly. Low and moderate findings are printed and do not fail, as before. The raw command is still
available locally: `pnpm audit` shows the full report and still exits non-zero for the advisory below.

## Current exception

| Field | Value |
| --- | --- |
| Advisory | GHSA-fc5q-39xc-vjpf (CVE-2026-112366), high, picomatch ReDoS through single-branch repeated extglobs |
| Affected | picomatch `<=4.0.7`; no patched release (pnpm reports `<0.0.0`; npm `latest` is 4.0.7) |
| Reviewed findings | picomatch 2.3.2 via `.>typescript-eslint>@typescript-eslint/typescript-estree>fast-glob>micromatch>picomatch`; picomatch 4.0.7 via `.>vitest>picomatch` |
| Scope | development only (root devDependencies `typescript-eslint` and `vitest`) |
| Owner | shaangill025 |
| Created | 2026-11-18T03:27:59Z |
| Expires | 2026-12-02T03:27:59Z (14 days; CI fails at and after this instant) |

This is an accepted risk, not a fix. The advisory remains open and the audit is not clean.

## Exposure review (2026-11-18, pnpm 10.21.0)

Evidence gathered on PR #16's branch. It shows current exposure only; development-only does not by itself make a
dependency safe.

- `pnpm audit --prod --json` reports no advisories (74 production dependencies), and
  `pnpm list -r --prod --depth Infinity` contains no picomatch, micromatch, fast-glob or tinyglobby.
- `pnpm why -r picomatch` shows picomatch only under the root devDependencies `typescript-eslint` (2.3.2 via
  fast-glob and micromatch) and `vitest` (4.0.7, also via vite, tinyglobby and fdir). No workspace package under
  `packages/` depends on either. `pnpm audit` lists one canonical path per installed version; the other routes
  shown by `pnpm why` sit under the same two root devDependencies.
- No source in `packages/` or `tools/` imports picomatch, micromatch, fast-glob, tinyglobby or another glob
  matcher. Application code never turns archived HTML, captured text, URLs or other user content into a glob.
- The patterns these tools receive are fixed and repository-controlled: Vitest's `include` list in
  `vitest.config.ts`, Vite's own defaults, and ESLint's `ignores` in `eslint.config.js` (ESLint matches those
  with minimatch, not picomatch). typescript-estree uses fast-glob only to expand `parserOptions.project`, which
  this repository does not set.

Residual risk: a developer or CI run could still pass a crafted glob to these tools (for example a Vitest CLI
filter or a future config change), and a change to the config or dependency graph can add new exposure. The
worst case is a slow or hung local or CI tool run (denial of service); no shipped artifact contains picomatch.

## What the gate enforces

The gate passes a high or critical advisory only when all of these hold; otherwise every path of that advisory
is reported as `blocked` and the step fails:

- the GHSA, package, severity and CVE equal the exception's;
- every reported (version, path) pair is one of the reviewed findings, so a new path or version refuses the whole
  advisory;
- each path starts at the workspace root, and its root package is a root `devDependency` that is not also a
  production, optional or peer dependency;
- the production-only audit (`pnpm audit --prod --json`) does not report the advisory;
- the advisory still has no patched version; once one is published the gate fails until the upgrade lands and
  the exception is removed;
- the exception is valid and has not expired.

It fails closed, and prints why, when:

- the clock reaches `expiresAt` (checked from the real clock even if the audit is clean; there is no clock or
  policy override);
- the policy is malformed: unknown or missing fields, a non-development scope, timestamps that are not exact UTC
  seconds, a `createdAt` in the future, a window longer than 14 days, an owner that is not a GitHub login, or
  tracking that is not an issue in this repository;
- a reviewed finding is no longer reported (stale exception: remove or narrow it);
- pnpm cannot run, prints non-JSON (network or registry errors, including the plain-text output of
  `ignore-registry-errors`), or exits with anything other than 1 when vulnerabilities are counted and 0 when none
  are (exit 0 alone is never trusted);
- the report shape is unknown: extra or missing top-level keys, a malformed advisory, an unknown severity, a
  non-empty `muted` list, or per-severity counts outside the range implied by the enumerated advisories (which
  catches advisories hidden by `auditConfig.ignoreGhsas` or `ignoreCves`).

Limits:

- pnpm 10.21's audit JSON marks every path `dev: false` and counts all dependencies as production, so the gate
  derives development scope from the production-only audit and the root manifest rather than from that metadata.
- The production-only audit is a second network call; if it fails, the gate fails.
- The gate checks policy form and dates, not who edited the file. Review of the policy file is the control
  against an unapproved renewal.
- The end-to-end CLI test uses a POSIX stub for `pnpm` and is skipped on Windows; CI runs the gate on ubuntu
  only, as it ran the audit before.

## Renewal and removal

No automatic renewal. Extending or changing the exception needs new explicit owner approval, recorded on the
tracking issue, and a new 14-day maximum window. When an upstream fix is released: upgrade, remove the exception
entry, confirm `pnpm audit` passes with no exception, and only then close issue #21.
