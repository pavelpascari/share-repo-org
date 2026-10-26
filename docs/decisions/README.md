# Architecture decisions

Short records of decisions that change a core boundary, invariant, or version-sensitive choice. One file per decision, numbered in order. Supersede a decision with a new record rather than rewriting history.

Each record has: **Status**, **Context**, **Decision**, **Consequences**.

| # | Decision | Status |
|---|---|---|
| [0001](0001-stack-versions.md) | Stack versions and tool compatibility | Proposed |
| [0002](0002-one-wrangler-config-per-worker.md) | One Wrangler config per Worker, shared D1 and migrations | Proposed |
| [0003](0003-d1-batches-and-transactional-outbox.md) | D1 atomicity through batches and a transactional outbox | Proposed |
| [0004](0004-workspace-scoped-composite-foreign-keys.md) | Workspace-scoped composite foreign keys | Proposed |
| [0005](0005-coverage-ratchet.md) | Coverage floors and never-decrease ratchet | Accepted |
| [0006](0006-authentication-with-better-auth.md) | Better Auth tables, GitHub sign-in via `genericOAuth`, E2E seam | Accepted |
| [0007](0007-audit-events.md) | Append-only audit events written in the same batch | Accepted |
| [0008](0008-v1-personal-account-repositories.md) | v1 sells personal-account repositories, with write access | Accepted |
| [0009](0009-entitlement-policy-v1.md) | Entitlement policy v1: creator-set grace period, derived entitlements, simulated source | Accepted |
| [0010](0010-grant-ownership-and-reconciliation.md) | ShareRepo manages only access it created; per-repository reconciliation | Accepted |
| [0011](0011-paddle-connection-and-tenant-credentials.md) | Paddle by API key, automatic webhook destination, envelope-encrypted tenant credentials | Accepted |
| [0012](0012-purchase-claims.md) | Purchase claims: checkout reference, emailed claim link, audited manual link | Accepted |
| [0013](0013-database-timers-and-expiry-confirmation.md) | Timers stay in the database; expiry is confirmed before revocation | Accepted |
| [0014](0014-failure-handling-and-alerting.md) | Failure records, dead-letter queue, operator access, email alerts | Accepted |
| [0015](0015-data-lifecycle.md) | Data lifecycle: retention, export, workspace and account deletion | Accepted |
| [0016](0016-manual-access-source.md) | Manual access: an entitlement source without a payment provider | Accepted |
| [0017](0017-manual-access-end-of-day.md) | A manual access ends after its date everywhere on Earth | Accepted |
