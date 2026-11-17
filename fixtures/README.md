# Fixtures

Synthetic data only. Nothing here may come from a real X account, a real Obsidian vault, or any user archive. Generate fixtures programmatically or write them by hand with invented names, IDs, and text. Never commit credentials, tokens, or real exports (AGENTS.md, SEC-01).

Platform IDs in fixtures are strings, including 19-digit values, so tests exercise precision handling.

## xarchive

`fixtures/xarchive/` holds hand-written files in the export format of `sytelus/xarchive` (MIT) at the
pinned commit and version recorded in `packages/store/src/xarchive.ts`. `v1-legacy.json` has no
`schema_version`; `v2-update.json` is a schema 2 cumulative file containing a tombstone and an
unparseable date. All accounts, IDs, and text are invented.
