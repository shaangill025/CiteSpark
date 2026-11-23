# M1-08 owner live acceptance (your real X account)

Status: **kit exists; the live run has NOT been done.** Nothing below is a result. Agents never touch your account;
you run this yourself. It closes blocker B8 (`docs/f0/blockers.md`) and the owner-run part of the M1-08 gate
(`docs/f0/implementation-plan.md`): one full pass, one interrupted-and-resumed pass, in Chrome and in Edge.

Requirement coverage: CAP-01 (passive capture works on real X), CAP-02/Q22 (one account, account-bound),
CAP-03 (resumable), CAP-04 (pause/resume, states), CAP-05 (pacing, no auth bypass), CAP-06 (honest complete),
CAP-07/Q31 (pause when X changes), SEC-04 (no credentials in stored output), Q20 (Chrome and Edge), Q21 manual
capture, Q40 (read-only X). T02 live criteria: full pass, resume, partial/complete honesty, credential scan.

## 0. Prerequisites

- macOS (primary), Linux or Windows; Chrome and/or Edge installed; Node 24+ and pnpm 10.21.0 (see `.nvmrc`).
- A checkout of this branch with `pnpm install` done.
- A bookmarks collection large enough to need many pages (about 20 posts per page). A few hundred is a good test.
- Your normal browser profile is never used. The kit makes a dedicated one outside the repo
  (default `~/.citspark-live-kit/<browser>/`, or `--dir <path>`; keep the path short, a Unix socket path is limited
  to about 100 bytes).

## 1. Set up (once per browser)

```sh
pnpm install
pnpm live-kit:setup --browser chrome      # or: --browser edge
```

It builds the extension, creates the dedicated profile, copies the unpacked extension into the kit, bundles the
native host, and writes the host manifest **inside the dedicated profile** (`<profile>/NativeMessagingHosts/`),
with `allowed_origins` restricted to the one pinned extension ID. It prints the exact next commands.
**Pass:** exit 0 and the printed instructions. **Fail:** any error (a refusal naming your real browser directory
is correct behaviour, not a failure of the kit).

Windows: the host is registered under `HKCU\Software\{Google\Chrome|Microsoft\Edge}\NativeMessagingHosts\com.citspark.native_host`
(per user, not per profile) and removed again by teardown only if it still points at the kit's manifest. The
Windows path is implemented and unit-tested with an injected registry runner but has never run on Windows.

## 2. Start the desktop core and the browser

1. Terminal A (leave it running): `pnpm live-kit:desktop --browser chrome`.
   Expected: "Citspark desktop core running. Library: ..." and later one line per job state change.
   The core is the real IPC server, pairing, capture handlers and store; there is no Electron shell yet (M2-01).
   Pairing is held in memory: if you stop the core you must pair again. Do not stop it for the resume test below.
2. Terminal B: `pnpm live-kit:launch --browser chrome` (or paste the command setup printed). A fresh Chrome window
   with an empty profile opens.
3. In that window open `chrome://extensions` (`edge://extensions` in Edge), enable Developer mode, **Load unpacked**,
   choose `<kit>/<browser>/extension`. (The `--load-extension` flag is not used: current branded Chrome and Edge
   ignore it.) **Pass:** the extension ID shown is `ifknmknhnlkmajhekjlicgcnmgbholce` and Details lists no site access
   beyond x.com (Citspark capture asks only for native messaging).

On macOS the first browser launch may ask for permissions; the kit keeps everything outside protected folders.

## 3. Sign in and pair

| Step | Do | Expected | Pass / fail | Covers |
| --- | --- | --- | --- | --- |
| 3.1 | In the new profile open `https://x.com` and sign in yourself (including any 2FA). | You reach your home timeline. | Pass if signed in. The kit never sees your password. | Q22 |
| 3.2 | Click the extension icon. | Popup says the extension is not paired. | Pass if so. | CAP-02 |
| 3.3 | Click **Pair with Citspark**. The popup shows a 6-digit code. Type it into Terminal A when it asks, press Enter. Terminal A shows a second code; type it into the popup and **Confirm**. | Popup link state becomes ready. | Pass if ready within 2 minutes. A wrong code must be refused; five wrong codes lock pairing (restart the core). | SEC-04, M1-06 |
| 3.4 | Popup shows the detected account. | Account is yours (check the displayed label only; do not paste it anywhere). | Fail if it shows another account or none while signed in. | CAP-02 |

## 4. Full bookmarks pass

Before starting, set the **Daily page budget** in the popup high enough for the whole collection (default 300 pages;
about 20 posts per page) and **Save**.

| Step | Do | Expected | Pass / fail | Covers |
| --- | --- | --- | --- | --- |
| 4.1 | Select **Bookmarks**, click **Start**. Keep the x.com tab open and visible. | Popup shows the run text with a running state; Terminal A prints `job 1: running`. The page scrolls by itself at a human pace (2.5 to 6 s between scrolls). | Pass if the run continues without a pause reason (Terminal A and evidence later show committed pages). Fail if it stalls without a pause reason. | CAP-01, CAP-05 |
| 4.2 | Wait for the end. | Terminal A prints `job 1: complete`; popup says complete. Stop reason is `recognized_end`. | Pass only if state is **complete** after X's list actually ended. A `partial` state (gaps: deleted or unavailable posts) is an honest result: record it, do not call it complete. `paused`, `auth_required`, `rate_limited`, `failed` are not passes; record the reason code. | CAP-06, T02 |
| 4.3 | Run `pnpm live-kit:evidence --browser chrome`. | Writes an evidence JSON and prints that the scanner found nothing. | Pass if exit 0. Check `totals.pages`, `totals.distinctSources` against your expectation of the collection size, and `totals.gaps`. Fail (exit 2) if the gate refuses; do not share anything and report it. | SEC-04, B8 |
| 4.4 | Compare counts: `jobs[0].distinctSources` should be close to the number of bookmarks X shows or that you expect; `pages` x about 20 should be close to `records`. | Counts plausible, gaps explained. | Your judgment; write the numbers in your result. A large unexplained shortfall is a fail. | CAP-01, CAP-06 |
| 4.5 | Confirm X was not changed: your bookmark list and counts are identical to before, and the extension performed no like, bookmark, post or follow. | Unchanged. | Any change on X is a fail and a stop-everything bug. | Q40 |

## 5. Interrupt and resume

Use a fresh capture (a second Start creates a new job on the same library; that is fine, evidence lists jobs in order).

| Step | Do | Expected | Pass / fail | Covers |
| --- | --- | --- | --- | --- |
| 5.1 | **Start** a Bookmarks capture. After a few pages click **Pause**. | State becomes `paused` (stop reason `user_pause`); committed pages stay in the library. | Pass if paused within a few seconds and committed pages is more than 0 and below the total. | CAP-04 |
| 5.2 | Click **Start** again in the same popup. | The job resumes: a fresh pass from the top, re-reads committed pages, then continues to new ones and reaches `complete`. | Pass if it ends `complete` (or an honest `partial`) and distinct sources never drop. | CAP-03, CAP-06 |
| 5.3 | Start another capture; mid-pass **close the whole browser window** (all windows of the dedicated profile). Leave Terminal A running. | The job cannot be marked complete. Its state may read `running` until its lease expires, then it is reclaimable. | Pass if it never reads `complete`. Record what Terminal A printed. | CAP-03, CAP-06 |
| 5.4 | Relaunch (`pnpm live-kit:launch --browser chrome`), the extension persists in the profile; open x.com (you stay signed in), open the popup, **Start**. | Resume to `complete` or honest `partial`, with no duplicate sources: `distinctSources` equals the uninterrupted run (step 4) within the gaps you recorded. | Pass if counts match step 4 within recorded gaps. Fail on a smaller total or a `complete` after an incomplete scroll. | CAP-03, CAP-06 |
| 5.5 | Run `pnpm live-kit:evidence --browser chrome` again. | New file; scanner clean; `transitions` show running, paused, running, complete; `runsStarted` above 1 for resumed jobs. | Pass if exit 0 and transitions match what you did. | CAP-04, SEC-04 |

If the extension was reloaded or the browser was closed, the pairing may need renewing only if you stopped the core.

## 6. Failure observations (optional, only if they happen naturally)

Do not provoke X. If you see one, record the reason code from the popup or evidence: `rate_limited` (extension must
wait for Retry-After, then continue or stop; never retry aggressively), `auth_required` (sign in again; it must not
try to bypass), `unsupported_schema` (capture pauses and the library stays usable), `account_mismatch` (signed in as
someone else: pauses). These cover CAP-05 and CAP-07/Q31 on the live site. Absence of these events is not a pass or
a fail.

## 7. Repeat in Edge

Run sections 1 to 5 with `--browser edge` (each browser has its own profile, library, socket and evidence). Stop the
Chrome core first or use a different terminal; the two kits are independent and may both be installed.
**Pass:** the same criteria in Edge. Covers Q20.

## 8. Evidence you hand back, and teardown

`live-kit:evidence` writes JSON with **only**: tool, extension and Node versions, commit, browser name and version, OS,
job states and transitions with timings, page/record/distinct-source/gap counts, adapter versions, error codes.
It never contains cookies, tokens, CSRF values, handles, account IDs, post text, cursors or URLs. The exporter checks
its own output, then runs the repo credential scanner over the evidence file and the library directory, deletes the
file and exits 2 if anything is found. Send back the JSON and your pass/fail table; never the library file.

```sh
pnpm live-kit:teardown --browser chrome            # removes the host manifest, launcher, config, extension copy
pnpm live-kit:teardown --browser chrome --purge    # also deletes the kit's profile (your X login there), library, evidence
```

Teardown removes only what setup recorded and never touches your normal browser profile. Sign out of X in the
dedicated profile before `--purge` if you want the session revoked on X's side too (deleting the profile only removes
it locally).

## 9. Known limits of the kit

- The core is a development runner, not the desktop app; pairing is in memory.
- Transitions are sampled every 500 ms, so a state that lasts less than that may be missing from `transitions`.
- Windows and Linux paths are unit-tested only; macOS is the one that has been run end to end (setup, desktop start,
  evidence, teardown against a temporary HOME, no X account).
- Passing this checklist does not change any traceability status by itself; record the result in a follow-up
  commit that cites your evidence file.
