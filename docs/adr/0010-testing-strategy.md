# 0010. Testing strategy

Status: Decided.
Requirements: T01 to T15, §15 release blockers, LAN-01, SEC-04

## Context

§15 defines T01 to T15 and makes zero-loss, zero-credential-disclosure, and zero-protected-upload tests release blockers. Fixtures must be synthetic or explicitly authorized. The repository must never contain private vault content (§16).

## Options

| Criterion | Mostly E2E through the UI | Layered: pure-core tests, real-process fault injection, targeted E2E |
|---|---|---|
| Speed | Slow, flaky with timing. | Fast core suite; E2E only for workflows. |
| Crash and replay coverage | Hard to kill at exact points. | Child-process workers with named crash points (proven in `prototypes/capture-commit`). |
| Privacy leak coverage | Only what the UI exercises. | Mock providers record every outbound request and assert on all of them. |

## Decision

Layered testing:

- **Unit and property tests** (Vitest, fast-check) for parsers, merge, policy, chunking, ranking, and schema validation.
- **Real-process fault injection**: workers killed with SIGKILL (POSIX) or `TerminateProcess` (Windows) at named points. The F0 prototype found that splitting the cursor update from the page commit broke 6 of 9 crash tests, so the suite catches the bug it targets.
- **Mock services**: a mock X server serving synthetic GraphQL-shaped fixtures, mock OpenAI, Anthropic, Gemini, and OpenAI-compatible endpoints that record every request, and a fake vault directory.
- **E2E**: Playwright drives the Electron app and the extension in Chromium and Edge against the mocks. axe-core (MPL-2.0, dev only) runs on each screen; manual screen-reader passes cover what automation cannot.
- **Frozen evaluation set** for AI quality, versioned and hashed, frozen before any tuning (T12).
- **CI matrix**: macos-14 (arm64), macos-13 (x64), windows-2022, ubuntu-24.04. Release-blocking suites run on all four.

| Test | Layer | Where it runs | Release blocker |
|---|---|---|---|
| T01 capture replay | fault injection, store | every CI OS | yes (zero loss) |
| T02 coverage outcomes | unit + mock X | CI | |
| T03 attribution | fixtures through import, sync, citation | CI | |
| T04 sync | property tests + filesystem harness | every CI OS | yes (no silent overwrite) |
| T05 privacy | mock providers record all requests, traces, diagnostics | CI | yes (zero protected upload) |
| T06 pairing | protocol tests against the real socket | every CI OS | yes (unauthorized access) |
| T07 deletion | integration with restart | CI | |
| T08 backup | restore into fresh install, corruption cases | every CI OS | yes (zero loss) |
| T09 import | fixtures incl. malicious archives | CI | |
| T10 AI | frozen set, fixed and agentic modes, mock and real local models | scheduled, self-hosted for local models | |
| T11 performance | benchmark harness from F0 | reference machines, per release | |
| T12 quality | frozen set with independent review | per release | |
| T13 accessibility | Playwright + axe-core + manual screen readers | per release, each OS | |
| T14 clean install | packaged builds on clean VMs | per release | |
| T15 end-to-end | full workflow on synthetic library | per release, each OS | |

Credential disclosure (SEC-04) gets its own blocking check: a scanner runs over logs, diagnostics bundles, exports, backups, and fixtures produced by the test suites and fails on any planted test credential.

## Consequences

- Real local-model tests need hardware CI does not have. They run on owner or contributor machines with recorded hardware, and results are published with the compatibility matrix.
- Real authorized X samples are never committed. Owners can run the capture suite against their own account locally; only synthetic fixtures go into the repository.

## Still to validate

- Windows crash injection equivalent to SIGKILL (M1 store layer on the Windows runner).
