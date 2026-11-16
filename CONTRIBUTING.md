# Contributing

Thanks for helping. Read the [specification](docs/spec/citspark-spec-v1.0.md) first; MUST items are approved
obligations, PROPOSED items are defaults or targets that need validation. Scope changes need owner approval.

## Workflow

- One branch = one pull request. Large work is delivered as a stack: layer N is based on layer N-1, and each PR
  stays reviewable on its own.
- Use [Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`, `docs:`, `chore:`, ...).
- Open PRs ready for review using the PR template; explain **Why** before **What**.
- Update [traceability.md](docs/spec/traceability.md) when a requirement's status changes.
- Add tests for behavior you change; map them to the acceptance tests (T01-T15) where relevant.

## Data rules

- **Never commit private data**: no real X archives, vault notes, credentials, API keys, or tokens.
  Use small synthetic fixtures only. CI runs a secret scan.
- Reusing third-party code needs a pinned revision, license check, and an entry in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## Licensing

By contributing you agree your contribution is licensed under Apache-2.0 (see [LICENSE](LICENSE)).
Please follow the [Code of Conduct](CODE_OF_CONDUCT.md).
