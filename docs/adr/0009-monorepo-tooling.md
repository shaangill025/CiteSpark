# 0009. Monorepo and tooling

Status: Decided.
Requirements: Q33, Q34, SEC-06, §14, §16 (reproducible builds)

## Context

Four deliverables share types and protocol schemas: the desktop app, the browser extension, the Obsidian plugin, and the core library. §14 proposes TypeScript for the extension and UI. §16 requires reproducible builds and third-party attribution.

## Options

| Criterion | pnpm workspaces | npm workspaces | Nx or Turborepo on top |
|---|---|---|---|
| Strict dependency isolation | Yes. Packages see only declared dependencies. | No. Hoisting hides missing dependencies. | Depends on the package manager. |
| Shared version pins | Catalogs in `pnpm-workspace.yaml`. | Manual. | Manual. |
| Lockfile and reproducible installs | `pnpm-lock.yaml`, `--frozen-lockfile`. | `package-lock.json`, `npm ci`. | Same as underlying. |
| Extra tooling to learn | Small. | None. | Larger. Caching pays off only when builds get slow. |
| License | MIT | Artistic-2.0 | MIT |

## Decision

- **pnpm workspaces** with catalogs for shared versions. CI installs with `--frozen-lockfile`. Node LTS pinned in `.nvmrc` and `engines`.
- **Layout**

```text
apps/
  desktop/          Electron main, preload, renderer
  extension/        MV3 extension
  obsidian-plugin/  Obsidian companion plugin
  native-host/      native messaging relay (ADR 0006)
packages/
  core/             orchestrator, jobs, policy enforcement; no Electron imports
  protocol/         zod schemas, version negotiation, framing
  store/            SQLite schema, migrations, repositories
  capture-x/        X adapter (pure parsing + request planning)
  importers/        Citspark backup, xarchive, owner vault
  sync-obsidian/    reconcile and merge engine
  retrieval/        chunking, FTS generations, vector index, fusion
  ai/               provider adapters, answer validation, research loop
  worker-runtime/   sidecar management, resource governor
  backup/           archive, age encryption, restore
  ui/               shared React Aria components
fixtures/           synthetic fixtures only
```

- **TypeScript** in strict mode with project references, so each package builds and type-checks independently.
- **Vitest** for unit and integration tests, **Playwright** for E2E (ADR 0010).
- **ESLint** with typescript-eslint and Prettier.
- **Bundling**: Vite for renderer and extension, esbuild for the plugin and native host, electron-builder for installers.
- **Supply chain**: a CI license check against an allowlist compatible with Apache-2.0, dependency audit, and lockfile review. Bundled licenses go into a generated third-party notice file.
- **No task runner at first.** `pnpm -r` with topological ordering is enough. Add Turborepo (MIT) if CI time for an unchanged package exceeds a few minutes.

## Consequences

- Contributors need pnpm. Corepack pins the version through `packageManager` in the root `package.json`.
- Native modules (better-sqlite3) need Electron-specific rebuilds, handled by electron-builder.

## Still to validate

- M1-01 proves install, build, lint, and test from a clean clone on macOS, Windows, and Linux CI runners.
