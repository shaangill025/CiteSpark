# F0 prototypes

These prototypes are throwaway code for the F0 feasibility phase (spec §14). Production code does not import them. They use synthetic data only. No real X data, vault content, or credentials appear here.

Requirements: Node.js 24 or later (the scripts run TypeScript through Node's type stripping) and pnpm for the single dependency.

```sh
cd prototypes
pnpm install
pnpm test            # T01 capture replay, T08 backup encryption, FTS5 index-mode check
pnpm bench:fts5      # builds a 100,000-post corpus in /tmp/citspark-f0 and measures search (about 2 minutes)
pnpm bench:vector    # exact vector scan at 100,000 and 216,283 vectors (about 1 minute)
```

Add `-- --trigram` to `bench:fts5` to also build and measure the trigram index. An existing database built in the other mode is rebuilt automatically. Add `-- --rebuild` to regenerate the corpus.

| Directory | What it proves | Spec |
|---|---|---|
| `capture-commit/` | A capture page and its continuation cursor commit in one SQLite transaction. SIGKILL before, during, and after the commit loses no committed record, creates no duplicate identity, and never leaves the cursor ahead of the data. Replaying committed pages changes nothing. A lease blocks a second capture owner, including one started as a separate job for the same account and collection. Process crashes only: power-loss durability is not tested. | CAP-02, CAP-03, T01 |
| `fts5-bench/` | SQLite FTS5 keyword search over 100,000 synthetic posts plus 15,000 linked articles, cold and warm. | DAT-01, DAT-02, RET-02, T11 |
| `vector-scan/` | The cost of an exact in-memory vector scan at this corpus size, as float32 and as int8 with one scale per vector. | RET-01, T11 |
| `backup-age/` | Streaming age encryption with a passphrase and with an X25519 key. A wrong passphrase fails before any plaintext. A flipped byte or truncation fails, but only after earlier authenticated chunks were emitted, so restore must stage output. | BKP-02, T08 |

Results and their caveats are in [`docs/f0/benchmarks.md`](../docs/f0/benchmarks.md). Raw JSON results are in each `results/` directory.
