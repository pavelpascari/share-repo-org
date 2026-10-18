# 0005 — Coverage floors and never-decrease ratchet

**Status:** Accepted

## Context

ShareRepo's main risk is wrong repository access. We want very high, meaningful test coverage that can be checked locally and cannot slowly erode.

## Decision

- Per-package floors: `domain` targets ~100% branches and has a mutation score threshold; `db`, `integrations`, and application services are **≥ 90%** on lines, branches, functions, and statements. UI routes are covered by journey-based E2E targets rather than a line percentage.
- **Coverage never decreases.** Each package's committed threshold is the higher of its floor and its achieved coverage. Thresholds only move up.
- Local: `pnpm test:coverage` raises committed thresholds automatically when coverage improves (rounded down to 0.1 to avoid noise).
- Committed thresholds, including the domain mutation score, live in one root file, `coverage-thresholds.json`, read by `vitest.config.ts` and the Stryker config. `scripts/coverage-ratchet.ts` raises them (`update`) and runs the CI checks (`check`). Vitest's own `thresholds.autoUpdate` is not used because it can only rewrite literals in the Vitest config, not an imported file.
- CI fails when:
  1. measured coverage is below a committed threshold;
  2. a PR lowers any committed threshold compared to the base branch;
  3. measured coverage is clearly above a committed threshold but the raised threshold was not committed.
- The same ratchet applies to the `domain` mutation score.
- Escape hatch: a threshold may go down only in a PR that carries an explicit `coverage-decrease` justification, which must be approved in review (for example, deleting well-tested code). It is never automatic.

## Consequences

- Contributors commit threshold updates alongside code.
- Coverage numbers must be deterministic between local and CI runs, so one coverage provider (Istanbul) is used for all packages.
- Details and commands are in `docs/testing-strategy.md`.
