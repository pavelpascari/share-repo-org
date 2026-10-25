# ShareRepo testing strategy

## Purpose

ShareRepo's main risk is incorrect access: a paying subscriber without a grant, or a lapsed one who keeps it. The test suite exists to prove that desired state (entitlements) and observed state (grants) converge under duplicate, missing, out-of-order, and failed inputs. Coverage numbers support that goal; they do not replace it.

## Principles

1. **Everything runs locally.** `pnpm test` and `pnpm test:e2e` run on a developer machine with no network access to providers, using local D1 and the Workers runtime.
2. **No live credentials in the default suite.** Real GitHub and Paddle calls happen only in the opt-in sandbox suite.
3. **Prove access correctness, not line counts.** Each item in the cross-phase test matrix maps to a named scenario. A convergence property test checks the system as a whole.
4. **Test through ports.** Domain logic is pure. Time, IDs, HTTP, queues, and providers are injected, so behaviour that depends on them is deterministic.
5. **One test per invariant.** Every invariant in `domain-model.md` and every database constraint has a test that shows it rejects invalid data.
6. **CI runs the same commands as developers.** No CI-only setup and no hidden fixtures.

## Test layers

| Layer | Runs in | Covers | Package(s) |
|---|---|---|---|
| Domain unit and property | Vitest, Node | Subscription policy (facts + time → entitlements), reconciliation planner, entitlement and grant state machines, capability checks | `packages/domain` |
| DB integration | Vitest, Workers pool, local D1 with migrations applied per test file | Repositories, unique/check/foreign-key constraints, composite workspace foreign keys, `batch()` atomicity, partial unique indexes, migrations from empty | `packages/db` |
| Adapter contract | Vitest, Workers pool, injected `fetch` | GitHub and Paddle adapters against recorded, redacted fixtures: signature verification, payload parsing, pagination, error classification, rate limits, pending invitations | `packages/integrations` |
| Fake providers | Used by the layers below | In-memory GitHub and Paddle implementations of the ports, with fault injection | `packages/testing` |
| Application service and scenario | Vitest, Workers pool, local D1, in-process queue drain | The full flow event → refresh → entitlements → plan → mutate → observe → audit, run against fakes. One named scenario per matrix item. | `packages/application`, `packages/testing` |
| Model-based convergence | Vitest, Workers pool or Node, `fast-check` | Random event sequences with injected faults. Checks global invariants after a final reconcile. | `packages/testing` |
| Worker entry points | Vitest, Workers pool | Queue consumer, scheduled (cron) handler, and Workflow entry points: wiring, acknowledge/retry behaviour, idempotency | `apps/jobs`, `apps/web` |
| End-to-end | Playwright against local dev Workers, fresh local D1 per run, fake OAuth server | Critical journeys: sign in, create workspace, connect repositories, map offer, subscriber claim, access status | `apps/web` |
| Sandbox smoke | Opt-in, real GitHub test account and Paddle sandbox | Real provider behaviour that fixtures cannot prove | `packages/integrations`, `apps/*` |

## Required seams

Build these in Phase 0–1 so later phases can be tested without retrofitting.

| Seam | Production binding | Test binding | Why |
|---|---|---|---|
| `Clock` | System time (UTC) | Controllable clock | Grace periods, effective cancellation, invitation expiry, and workflow sleeps become ordinary tests |
| ID generator | Random/ULID | Deterministic sequence | Stable assertions and reproducible property-test failures |
| HTTP client / `fetch` | Global `fetch` | Fixture-backed or fake-backed `fetch` | Adapters are tested without network access or a version-specific request mock |
| Queue port | Cloudflare Queues producer | In-process queue that tests drain explicitly, with redelivery and reordering | Repeated delivery and crash-between-steps scenarios |
| Transactional outbox | D1 table drained by jobs | Same table, drained by the test | Event receipt, state change, and job intent commit in one `batch()` |
| OAuth provider | GitHub OAuth | Local fake GitHub OAuth server | E2E signs in through OAuth with no test-only login backdoor. Wired through endpoint overrides accepted only when `ENVIRONMENT=e2e` ([0006](decisions/0006-authentication-with-better-auth.md)) |
| Payment provider | Paddle Billing API and webhooks | `FakePaddle` in process; for E2E, an HTTP fake built on it (`apps/web/e2e/support/fake-paddle.ts`) with a payment page, lifecycle controls and signed webhooks | Purchases and subscription lifecycles with no Paddle account. The API override is accepted only when `ENVIRONMENT=e2e` |
| Mail | Cloudflare `send_email` binding | `FakeMail`; E2E posts to the fake Paddle's mailbox (`MAIL_CAPTURE_URL`, e2e only) | Claim links are read from captured mail |
| Secrets/key provider | Cloudflare secrets | Fixed test keys | Signature and envelope-encryption tests use known material |

## Fake providers

`packages/testing` contains in-memory `FakeGitHub` and `FakePaddle` that implement the same ports as the real adapters.

**State.** `FakeGitHub` models installations, selected repositories, users with immutable IDs and mutable logins, direct collaborators, pending invitations with expiry, and indirect access through teams or ownership. `FakePaddle` models customers, subscriptions with billing periods and scheduled cancellation, and an event log that can emit signed webhooks.

**Fault injection.** Each operation can be scripted to:

- fail with a retryable, rate-limited (including secondary rate limit), terminal, or user-action-required error;
- succeed but lose the response, so the mutation is applied and the caller sees a timeout;
- return stale state on the next read;
- simulate an outage for a time window measured by the test clock (`outage(until)`: 503 until the fake's clock reaches it);
- hang past the client's timeout (`hangNext(operation)`): the call fails as the real client fails a request its `AbortSignal` timeout aborted, `transient` with no status. A contract runs the same hang against the fake and against the real client over a `fetch` that stalls at its headers or mid-body (`packages/integrations/test/timeout.test.ts`).

**Crash between writes.** `crashingD1` (`packages/testing`) wraps a D1 binding so that its Nth write (a `batch()`, or a single INSERT, UPDATE or DELETE) fails before it runs or after it commits. `packages/application/test/crash.test.ts` (`crash/every-batch-boundary-converges`) runs each multi-write operation once to count its writes, then crashes at every write on both sides, re-runs it as the queue or the user would, and compares every workspace table, the account audit events and the fakes' state with the clean run. A case names the history a recovery may add (a mutation in doubt, resolved) and the failures an operation absorbs by design. A new multi-write operation adds a case.

Tests can also make out-of-band changes that act as drift: a human removes a collaborator, adds one manually, renames a user or repository, suspends an installation, or a subscriber declines an invitation.

**Keeping fakes honest.** One contract suite per port runs against both the fake and the real adapter backed by recorded fixtures. The sandbox suite runs the same contract against live providers. If a fake behaves differently from the fixtures, its contract run fails.

## Scenario catalog

Each scenario has a stable name used as the test title so coverage of the matrix can be checked by search. The phase column shows where it is first required.

| Scenario | Source | Layer | Phase |
|---|---|---|---|
| `isolation/cross-workspace-read-denied` | Matrix: workspace isolation; AGENTS: workspace isolation and authorization | Service, E2E | 1 |
| `isolation/cross-workspace-mutation-denied` | Same | Service | 1 |
| `isolation/composite-fk-rejects-cross-tenant-link` | Domain invariant 2 | DB | 0–3 |
| `isolation/job-without-workspace-scope-rejected` | Same | Entry point | 4 |
| `webhook/duplicate-delivery-is-noop` | Matrix: duplicate external events; AGENTS: duplicate webhooks | Service | 2, 5 |
| `webhook/out-of-order-does-not-regress` | Matrix: out-of-order events; AGENTS: out-of-order webhooks | Service, property | 3, 5 |
| `webhook/invalid-signature-rejected-before-persist` | Integrations: signature verification | Contract | 2, 5 |
| `queue/redelivery-is-idempotent` | Matrix: repeated queue delivery; AGENTS: repeated queue delivery | Service, entry point | 4 |
| `timing/sweep-replay-is-idempotent` | Matrix: workflow replay; AGENTS: workflow retries; renamed from `workflow/replay-is-idempotent` by [decision 0013](decisions/0013-database-timers-and-expiry-confirmation.md) | Entry point | 6 |
| `provider/mutation-succeeds-response-lost` | Matrix: provider success with lost response | Service | 4 |
| `crash/between-event-commit-and-enqueue` | Matrix: partial transaction and crash recovery | Service | 3–4 |
| `crash/between-mutation-and-observation` | Same | Service | 4 |
| `identity/username-change-keeps-identity` | Matrix: username change | Service, contract | 1 |
| `identity/unlink-relink-moves-subject-safely` | Matrix: identity unlink/relink | Service | 4–5 |
| `identity/unverified-email-match-grants-nothing` | Domain: identity linking | Service | 5 |
| `claim/token-single-use-and-expiring` | [Claim threat model](security/purchase-claim-threat-model.md) T2 | Service | 5 |
| `claim/get-never-mutates` | Claim threat model T3 | Entry point | 5 |
| `claim/request-does-not-reveal-purchases` | Claim threat model T4 | Service | 5 |
| `claim/request-rate-limited` | Claim threat model T5 | Service | 5 |
| `claim/checkout-start-rate-limited` | Claim threat model T5 | Service | 5 |
| `claim/checkout-reference-tamper-rejected` | Claim threat model T11 | Service | 5 |
| `claim/checkout-cannot-adopt-existing-customer` | Claim threat model T13 | Service | 5 |
| `connection/revoked-key-keeps-last-facts` | Decision 0011: connection loss | Service | 5 |
| `credential/envelope-bound-to-row` | AGENTS: encrypted, versioned tenant credentials | Platform, DB | 5 |
| `timing/renewal-during-scheduled-revocation` | Matrix: renewal during scheduled revocation; AGENTS: reactivation | Service, entry point | 5–6 |
| `timing/cancellation-revokes-at-effective-time` | AGENTS: cancellation timing | Domain, service | 3, 5 |
| `timing/past-due-within-grace-keeps-access` | AGENTS: grace periods | Domain, service | 3, 5 |
| `timing/grace-expiry-revokes` | Same | Domain, service | 3, 6 |
| `timing/stale-workflow-cannot-revoke-renewed` | Implementation plan, Phase 6 | Entry point | 6 |
| `timing/expiry-confirmed-before-revoke` | Decision 0013 | Domain, service | 6 |
| `timing/expiry-revokes-after-confirmation-window` | Decision 0013 | Domain, entry point | 6 |
| `timing/sweep-lag-alerts` | Decision 0014 | Entry point | 6 |
| `failure/exhausted-job-is-recorded-and-alerted` | Decision 0014 | Entry point | 6 |
| `failure/dead-letter-marks-row-failed` | Decision 0014; [operations threat model](security/operations-threat-model.md) O14 | Entry point | 6 |
| `failure/owner-sees-only-own-failures` | Decision 0014; isolation | Service, E2E | 6 |
| `operator/non-operator-gets-404` | Decision 0014; operations threat model O1, O2 | Entry point | 6 |
| `operator/actions-audited` | Decision 0014; operations threat model O4 | Service | 6 |
| `crash/every-batch-boundary-converges` | Matrix: partial transaction and crash recovery | Service | 6 |
| `provider/timeout-is-retryable` | Matrix: provider outage | Contract, service | 6 |
| `retention/prune-keeps-referenced-rows` | Decision 0015 | DB, service | 6 |
| `deletion/workspace-revokes-before-purge` | Decision 0015 | Service, E2E | 6 |
| `deletion/audit-delete-only-while-purging` | Decision 0015 | DB | 6 |
| `deletion/purging-is-one-way` | Operations threat model O10 | DB | 6 |
| `deletion/purge-touches-only-its-workspace` | Operations threat model O11 | Service | 6 |
| `deletion/cross-site-request-refused` | Operations threat model O7, O8, O12 | Entry point | 6 |
| `deletion/account-revokes-and-removes-identity` | Decision 0015 | Service | 6 |
| `export/contains-no-secrets` | Decision 0015; AGENTS: secret leakage | Service | 6 |
| `rotation/old-and-new-secret-both-accepted` | Phase 6: credential rotation | Service, entry point | 6 |
| `partition/one-installation-cannot-starve-others` | Phase 6: partitioned reconciliation | Service | 6 |
| `migration/upgrade-from-each-release-keeps-data` | Phase 6: migration procedures | DB | 6 |
| `security/no-secrets-in-stored-rows-or-logs` | Phase 6 acceptance | Service, entry point | 6 |
| `resource/selection-removed-blocks-new-provisioning` | Matrix: resource removal | Service | 2, 4 |
| `resource/rename-transfer-keeps-identity` | Integrations: GitHub risks | Contract, service | 2 |
| `connection/suspended-installation-surfaces-error` | Matrix: connection suspension | Service | 2, 4 |
| `connection/install-callback-bound-to-intent` | Implementation plan, Phase 2: callbacks cannot attach to the wrong workspace | Service, E2E | 2 |
| `invitation/pending-is-not-active` | AGENTS: pending invitations | Service | 4 |
| `invitation/expired-is-reissued-or-surfaced` | Matrix: pending invitation expiration | Service | 4 |
| `provider/rate-limit-backs-off-and-retries` | Matrix: rate limit; AGENTS: provider rate limits | Contract, service | 4 |
| `provider/transient-error-retries` | AGENTS: transient errors | Service | 4 |
| `provider/outage-recovers-on-scheduled-reconcile` | Matrix: provider outage | Service | 4, 6 |
| `drift/manual-removal-is-repaired` | Matrix: manual access drift; AGENTS: drift both directions | Service | 4 |
| `drift/unmanaged-access-is-not-revoked` | Same; Integrations: ownership | Service | 4 |
| `drift/indirect-access-reported-accurately` | Integrations: ownership | Service | 4 |
| `manual/grant-provisions-without-subscription` | [Decision 0016](decisions/0016-manual-access-source.md): manual access | Service | 6 |
| `manual/duplicate-grant-is-noop` | Decision 0016; AGENTS: duplicate requests | Service | 6 |
| `manual/revoke-removes-access` | Decision 0016; threat model M2 | Service | 6 |
| `manual/end-date-expires-via-sweep` | Decisions 0013, 0016; threat model M2 | Service, entry point | 6 |
| `manual/follows-current-offer-version` | Decision 0016 | Service | 6 |
| `manual/workspace-deletion-withdraws-and-restores` | Decisions 0015, 0016 | Service | 6 |
| `manual/account-deletion-revokes-manual-access` | Decisions 0015, 0016; threat model M2 | Service | 6 |
| `manual/open-limit-and-rate-limit` | Decision 0016; threat model M1 | Service | 6 |
| `manual/concurrent-changes-converge` | Decision 0016; threat model M4 (security review) | DB, service | 6 |
| `manual/owner-grants-and-revokes-by-login` | Decision 0016 | Entry point, E2E | 6 |
| `claim/owner-unlink-removes-access` | Decision 0016; claim threat model T12 | Service | 6 |
| `audit/every-state-change-has-audit-event` | Matrix: audit completeness; AGENTS: audit completeness | Service, property | 1 onward |
| `audit/no-secrets-in-logs-or-audit` | Matrix: secret redaction; AGENTS: without secret leakage | Service | 0 onward |

A CI check fails if any scenario name in this table has no matching test once its phase is complete.

## Model-based convergence test

A `fast-check` model-based test drives application services against the fakes, local D1, and the in-process queue.

**Generated commands:**

- subscription lifecycle facts: create, renew, past-due, recover, pause, cancel at period end, cancel immediately, expire, reactivate;
- webhook delivery: deliver, duplicate, delay, reorder, drop (to be recovered by scheduled reconcile);
- identity: link, unlink, relink, rename;
- resource and connection: add or remove repository selection, rename, suspend or unsuspend installation;
- drift: manual collaborator removal or addition, invitation declined or expired;
- time: advance the clock by generated durations;
- runtime faults: redeliver a queue message, crash between named steps, lose a provider response, inject a rate limit or outage.

**Invariants checked after every step:**

- no record links across workspaces;
- every entitlement references its source, policy version, and validity interval;
- no grant created an entitlement;
- every state change has a matching audit event with a correlation ID;
- no secret appears in logs, audit details, or stored payloads.

**Invariants checked after quiescence** (drain queues, run scheduled reconcile, advance past pending timers):

- every active entitlement has a matching active or pending-invitation grant, or a classified error that explains why not;
- no ShareRepo-managed grant exists without an active entitlement;
- access that ShareRepo does not own was never revoked;
- replaying the full event log from scratch produces the same entitlements.

Failing seeds are recorded as regression tests in the scenario layer.

## Coverage policy

### Floors

| Package | Floor | Additional gate |
|---|---|---|
| `packages/domain` | ~100% lines and branches | Stryker mutation score, ratcheted |
| `packages/db` | ≥90% | One test per constraint |
| `packages/integrations` | ≥90% | Contract suite per port |
| `packages/platform` | ≥90% | Redaction tests for the logger |
| Application services (`packages/application`, from Phase 1) and `apps/jobs` | ≥90% | Scenario catalog complete for the phase |
| UI routes and components | Journey-based | Each critical journey in `product.md` has an E2E test |

All packages use V8 coverage so results are identical locally and in CI and can be merged across Node and Workers projects. Istanbul was tried first but, under the Workers plugin, intermittently recorded a module twice (at source and transpiled positions) when the module was reused across test files, which made thresholds flaky. Package barrels (`src/**/index.ts`) that only re-export are excluded.

### Ratchet: coverage never decreases

The floor is a starting point. Each package's committed thresholds (lines, branches, functions, statements, and mutation score for domain) can only go up.

- **Local:** committed thresholds live in `coverage-thresholds.json`, which `vitest.config.ts` reads as per-package glob thresholds and `packages/domain/stryker.config.mjs` reads for the mutation break threshold. `pnpm test:coverage` runs coverage and then `scripts/coverage-ratchet.ts update`, which raises thresholds to measured coverage rounded down to 0.1 and never lowers them. Developers commit the raised values with their change. A glob that matches no files, or a metric with nothing to count, is neither checked nor raised.
- **CI check 1, floor:** measured coverage must meet or exceed the committed thresholds.
- **CI check 2, no lowering:** `scripts/coverage-ratchet.ts check --base <base thresholds>` compares thresholds in the PR against the base branch and fails if any value decreased or a scope was removed.
- **CI check 3, gains are committed:** if measured coverage exceeds a committed threshold by more than the rounding margin, CI fails and asks the author to run `pnpm test:coverage` and commit the update.

**Escape hatch.** Coverage can legitimately drop, for example when well-tested code is deleted. A lowered threshold is accepted only when the PR carries an explicit `coverage-decrease` justification, such as a label plus a short reason in the description, and passes review. It is never automatic. CI passes that reason to the check as `COVERAGE_DECREASE_REASON`; with it set, check 2 reports the decrease instead of failing.

## Commands

| Command | Runs | Needs network/credentials |
|---|---|---|
| `pnpm test` | Domain, DB, contract, service, scenario, convergence, and entry-point tests | No |
| `pnpm test:coverage` | `pnpm test` with merged V8 coverage and thresholds, then raises committed thresholds | No |
| `pnpm test:mutation` | Stryker on `packages/domain`, with ratcheted break threshold | No |
| `pnpm test:e2e` | Playwright against local Workers, fresh D1, fake OAuth server | No |
| `pnpm test:sandbox` | Contract and smoke tests against real GitHub test account and Paddle sandbox | Yes, opt-in |

CI on every PR runs `pnpm lint`, `pnpm typecheck`, `pnpm test:coverage` with the three ratchet checks, the scenario-catalog check, migration validation from an empty database, `pnpm test:e2e`, and the build. `pnpm test:mutation` runs on PRs that touch `packages/domain` and nightly. `pnpm test:sandbox` runs manually or on a schedule with dedicated secrets and never gates merge.

## Fixtures

- **Recorded and redacted.** Provider responses and webhooks are recorded from sandbox or test accounts, then redacted: tokens, emails, names, and IDs are replaced with stable synthetic values. A redaction check fails if a fixture contains token-shaped strings or real email domains.
- **Exact raw bytes.** Webhook fixtures store the raw body as received, and the signature is computed over those bytes with a test secret. Tests cover a valid signature, a tampered body, re-serialised JSON (which must fail), a wrong secret, and a missing header.
- **Versioned.** Fixtures record the provider API or webhook version so schema changes appear as explicit fixture updates.
- **Upgrade fixtures, one per migration.** Every migration `NNNN` adds `packages/db/test/fixtures/at-NNNN.sql` in the same change: representative rows valid at that migration, with at least one row in every table that exists then, satisfying its constraints and triggers. Start from the previous fixture and add rows for what `NNNN` introduces. `packages/db/test/upgrade.test.ts` (scenario `migration/upgrade-from-each-release-keeps-data`) has one test per fixture. Each test applies `0000…NNNN` to an empty database, loads the fixture, and applies the remaining migrations. It then checks `PRAGMA foreign_key_check` (no rows) and `PRAGMA quick_check` (`ok`; D1 does not allow `integrity_check`). It also checks that every fixture row survives with every value, and that columns added later hold their declared default (or null). The newest fixture has nothing to upgrade through until the next migration lands, and that migration's test then exercises it. A test fails when the set of fixtures differs from the set of migrations. A migration that changes existing values on purpose (a backfill, a dropped or renamed column) must make that expectation explicit in the test.
- **Secret leakage test.** Test setup injects canary values into every secret, token, and credential. A shared assertion runs after every service and scenario test and fails if any canary appears in captured logs, audit event details, stored external-event metadata, or error messages.

## Version-sensitive details

Tool versions and the testing APIs this strategy relies on are recorded in [`docs/decisions/0001-stack-versions.md`](decisions/0001-stack-versions.md). In summary:

- Workers tests use `@cloudflare/vitest-plugin` (the renamed `vitest-pool-workers`) on Vitest 4.1, in a root `projects` config alongside Node projects, with merged V8 coverage.
- D1 migrations are applied with `readD1Migrations`/`applyD1Migrations`; queue consumers are tested with `createMessageBatch`/`getQueueResult`; cron with `createScheduledController`; Workflows with disposable introspectors that can mock steps and skip sleeps.
- **Storage is isolated per test file, not per test.** Tests in one file share D1 state, so each test creates its own workspace and IDs, or resets in `afterEach`. Isolation tests must not pass by accident because another test's data happens to be absent.
- Vitest `coverage.thresholds.autoUpdate` can only rewrite literal values in the Vitest config, not an imported JSON file, so `scripts/coverage-ratchet.ts` owns raising thresholds. One file then feeds both Vitest and Stryker.
- Stryker runs only on `packages/domain` and requires Vitest 4 until stryker-js #6210 is fixed.
- Outbound HTTP is tested through injected `fetch`. `fetchMock` no longer exists in `cloudflare:test`; MSW with `@msw/cloudflare` is the fallback if needed.
