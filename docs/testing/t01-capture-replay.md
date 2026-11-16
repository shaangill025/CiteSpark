# T01 capture replay

Spec §15 T01: interrupt before, during, and after page commit; recover all committed records with zero duplicate
canonical identities or advanced-uncommitted cursors. Release-blocking; runs on every CI OS (ADR 0010).

## What runs

`packages/store/src/t01.test.ts` starts `packages/store/src/testing/t01-worker.ts` as a separate Node process
against a WAL store file and the synthetic feed (`packages/store/src/testing/synthetic-feed.ts`, 12 overlapping
pages, 19-digit string IDs, shared text under distinct IDs, edited text).

- **Fault points:** `mid-page` (half the records written, transaction open), `before-commit` (all writes done,
  transaction open), `after-commit` (committed, result not yet returned).
- **Pages:** first (0), middle (6), last (11).
- **Kill:** the worker blocks at the fault point and the test process kills it with `SIGKILL`. Node maps this to
  `TerminateProcess` on Windows. Killing from outside avoids racing a self-kill against the next statement.
- **Lease:** each worker retains the `Lease` token its `acquire` returned and passes it to every commit; the
  token is validated inside the commit transaction. A resumed worker on a `complete` job passes `null` and may only
  have committed pages acknowledged.
- **Resume:** after checking that an unexpired lease blocks a second owner, a new owner reclaims the expired lease and
  either starts a fresh pass from the top with new cursors (desktop restart, ADR 0005) or re-sends the unacknowledged
  page in the same pass (extension retry). 3 points × 3 pages × 2 resume modes = 18 cases.
- **Checks after the kill:** only durable pages are recorded, exactly their platform IDs are present, no observation
  belongs to an uncommitted page, and the job cursor equals the last committed continuation.
- **Checks after resume:** one source per platform ID, one version per distinct text, one membership per source, one
  observation per version, job `complete` with a null cursor, and in a fresh pass every re-read committed page adds no
  records.

Scope: this proves atomicity against process kills. As noted in ADR 0002, it does not prove durability against power
loss or OS crash. T01 with real authorized capture samples remains an owner-run check (ADR 0005).

## Mutation check

The M1–M7 table was recorded at `451a9a9`, before integrating the M1-03 retained-lease API. It has not been
re-run since.

Each mutation was applied by a throwaway script to `packages/store/src/capture.ts` or `migrations.ts`, then
`npx vitest run packages/store/src/t01.test.ts packages/store/src/capture.test.ts` was run and the mutation was
reverted. Recorded on macOS (Apple silicon), Node 26, for M1-04.

| Mutation | T01 cases failing | Unit tests failing |
| --- | --- | --- |
| M1: run the commit without a transaction | 12 / 18 | 1 |
| M2: advance the cursor in its own transaction before writing records | 12 / 18 | 3 |
| M3: drop the same-pass replay check | 3 / 18 | 3 |
| M4: drop per-job observation de-duplication | 18 / 18 | 2 |
| M5: drop skip rejection within a pass | 0 / 18 | 1 |
| M6: drop the account and collection binding check | 0 / 18 | 2 |
| M7: advance the cursor on every page attempt, before the commit | 12 / 18 | 2 |

Every mutation is caught. M5 and M6 are not crash-recovery properties, so `capture.test.ts` covers them.

### After integrating M1-03 leases

Recorded the same way on macOS for the integrated branch (`capture.test.ts`, `jobs.test.ts`, `t01.test.ts`).

| Mutation | Tests failing |
| --- | --- |
| L1: `withLease` runs the work without checking the lease | 2 |
| L2: drop the same-pass replay check | 2 / 18 T01 |
| L3: ignore the persisted source ID and dedupe observations on any constraint | 28 across T01 and `capture.test.ts` |
| L4: do not pause the job on an account or collection mismatch | 1 |
