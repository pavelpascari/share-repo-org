# 0007 — Audit events: one append-only table, written in the same batch

**Status:** Accepted (Phase 1)

## Context

`AGENTS.md` requires every state-changing operation to produce an audit event with correlation identifiers. The domain model says audit history is append-only (invariant 10). D1 has no interactive transactions ([0003](0003-d1-batches-and-transactional-outbox.md)). Some events belong to a workspace, such as a workspace being created. Others belong to an account, such as a user being created or a GitHub identity being linked.

## Decision

- **One table, `audit_events`:**
  - columns: `id`, `scope`, `workspace_id`, `actor_type`, `actor_id`, `action`, `target_type`, `target_id`, `reason`, `correlation_id`, `occurred_at`, `details`;
  - `scope` is `workspace` or `account`. A CHECK requires `workspace_id` to be set for `workspace` scope and null for `account` scope;
  - workspace-scoped rows have a foreign key to `workspaces`. The schema conformance test exempts this table explicitly, because account-scoped rows have no workspace.
- **Append-only in the database.** `BEFORE UPDATE` and `BEFORE DELETE` triggers `RAISE(ABORT)`. Corrections are new events. Privacy deletion, when needed, will be a deliberate migration with its own decision.
- **Same batch as the change.** Repositories take the audit event and add its insert to the same `db.batch()` as the state change. There is no separate "log audit" call that could be skipped or fail on its own.
- **Typed catalog.** `@sharerepo/domain` defines each action, its scope, target type and a Zod schema for `details`. `details` never holds secrets, tokens or emails; the canary assertion covers audit rows. Phase 1 actions:
  - `user.created`
  - `identity.linked`
  - `identity.snapshot_updated`
  - `auth.signed_in`
  - `auth.signed_out`
  - `workspace.created`
  - `workspace.renamed`
  - `membership.added`
- **Actors:** `user`, `system`, `operator` or `provider`, with an ID. Every row carries the request's correlation ID (`NOT NULL`).
- **Completeness is tested generically.** A shared helper snapshots every non-audit table before and after an operation. If anything changed, it requires at least one new audit event with the operation's correlation ID. This backs the scenario `audit/every-state-change-has-audit-event` and runs for every service test.

## Consequences

- An operation's audit row commits or fails together with its change.
- Better Auth's internal writes (sessions, verifications) are not individually audited. Sign-in and sign-out are audited as `auth.*` events from hooks. Session rows are excluded from the completeness helper by name, with this decision as the reason.
