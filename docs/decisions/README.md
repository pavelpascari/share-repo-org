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
