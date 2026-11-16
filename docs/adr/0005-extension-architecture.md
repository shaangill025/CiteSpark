# 0005. Browser extension architecture

Status: Decided.
Requirements: CAP-01 to CAP-08, MIG-01, SEC-04, SEC-06, SEC-07, Q20, Q22, Q38, Q40, T01, T02, T09

## Context

Capture runs in Chromium-based browsers through a Manifest V3 extension using the user's signed-in session (CAP-01). Credentials stay in the browser and are never stored or sent to the desktop (SEC-04). CAP-01 requires inspecting reuse candidates for license, dependencies, and network behavior before adopting them. Q38 makes xarchive the first third-party import format.

## Candidates inspected

Inspected at pinned commits through the GitHub API and package manifests. No code was executed.

| | twitter-web-exporter | xarchive |
|---|---|---|
| Repository | `prinsss/twitter-web-exporter` | `sytelus/xarchive` (assumed match, needs owner confirmation) |
| Commit | `ddf2b0c823680b904daae166f3eb05b81950ce7e` (v1.4.3) | `ae9d0263617a200ce142e64fb2ddc6301ebf19cf` |
| License | MIT | MIT |
| Form | Userscript (Tampermonkey). | MV3 extension. |
| Capture method | Passively intercepts X's own XHR responses. | Calls X GraphQL endpoints itself. |
| Credentials | Reads none. | Reads `ct0` and `twid` cookies and auth/CSRF headers. Has a hard-coded bearer token fallback. |
| Request changes | None. | A declarativeNetRequest rule rewrites Origin and Referer. |
| Network hosts | Loads about 10 libraries at runtime from `cdn.jsdelivr.net`. | `x.com`, `abs.twimg.com`. |
| Dependencies | preact, dexie, i18next, and others (licenses not yet verified one by one). | Vendored Dexie (Apache-2.0). |
| Tests | None. | Tests with fixtures. |
| Activity | About 2.8k stars, release Aug 2026. | Created Apr 2026, about 127 stars, no releases. |

## Options

1. Fork twitter-web-exporter. Passive interception is the safest capture model. But it is a userscript, loads code from a CDN at runtime (MV3 forbids remote code, and SEC-06 requires verifiable updates), and has no tests.
2. Fork xarchive. It is already MV3 and has tests. But it persists and replays credentials, spoofs request headers, and embeds a bearer token. Each conflicts with SEC-04 (credentials stay out of storage) or CAP-05 (never bypass restrictions).
3. Write a Citspark-owned MV3 adapter. Use both projects as references for response shapes and parsing edge cases, with attribution and pinned commits.

## Decision

Option 3.

- **Adapter interface:** a versioned `CaptureAdapter` (`id`, `version`, `detectAccount`, `listCollections`, `parsePage`, `nextRequest`) in `packages/capture-x`. Parsing is pure TypeScript over JSON, tested against synthetic fixtures modeled on the documented response shapes.
- **Capture model:** the content script runs in the X page. It observes X's own responses to learn current request templates, then pages through collections with `fetch` from the page context so the browser attaches the session. The extension never reads, stores, or forwards cookies or tokens. No header rewriting. No embedded tokens.
- **Rate limiting:** a conservative pacer with jitter, backoff on 429 and errors, a daily page budget, and a visible pause (CAP-05). Stop on any account mismatch (CAP-02).
- **Pages to the desktop:** each parsed page goes over native messaging (ADR 0006) with its account identity, collection, cursor in, and cursor out. The desktop commits atomically (CAP-03). The extension keeps only in-memory job state.
- **Import:** implement xarchive's export format as the first importer (MIG-01, Q38), with preview before commit and the same idempotent commit path.
- **Packaging:** no remote code. All dependencies bundled and listed in the license inventory. Unpacked install documented; store listing is an owner decision.

## Consequences

- More initial work than a fork. In exchange, the capture path meets SEC-04 and CAP-05 and has tests from day one.
- X changes break parsing. Adapter version and fixture tests make breakage visible. The adapter is the only component that knows X's shapes.
- Attribution for any copied parsing logic goes into NOTICE with the source commit.

## Still to validate

- Owner confirmation that `sytelus/xarchive` is the intended project (see `docs/f0/blockers.md`).
- Real authorized capture samples. F0 used synthetic fixtures only. T01 restart tests with real samples need the owner to run capture against their own account.
- Per-dependency license check of twitter-web-exporter if any code is copied rather than referenced.
