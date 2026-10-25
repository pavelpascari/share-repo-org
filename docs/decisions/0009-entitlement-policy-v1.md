# 0009 — Entitlement policy v1: creator-set grace period, derived entitlements, simulated source

**Status:** Accepted (grace period is a product decision, 2026-10-18)

## Context

Phase 3 must turn commercial facts into desired access and settle a deferred decision: fixed or creator-configurable grace periods. Paddle is not integrated until Phase 5, so the entitlement core needs a source it can be proven against.

## Decision

- **Grace period:** each offer sets `grace_period_days`, an integer from 0 to 30 with a default of 7. A past-due subscription keeps access until `past_due_since + grace_period_days`.
- **Policy is versioned code.** `ACCESS_POLICY_VERSION = 1` implements the product table:
  - trialing and active are granted, up to any scheduled cancellation;
  - past due is granted within the grace period;
  - paused is revoked;
  - canceled is granted until its effective end;
  - expired is revoked.

  Each entitlement stores `policy_version`, `offer_id` and `offer_version`. Offer versions are immutable snapshots, so every decision can be explained later.
- **Entitlements are derived**:
  - Processing re-reads the subscription from its source and applies it only if the source's own timestamp is newer than the stored one. It then recomputes that subscription's entitlements with a deterministic diff.
  - Stored entitlement states are `active`, `expired` and `revoked`. Pending, blocked and expiring are planner or validity facts, not entitlement states.
  - A reactivation creates a new entitlement row.
- **A simulated entitlement source** stands in for Paddle when `ENVIRONMENT` is not `production`.
  - It implements the same port Paddle will.
  - It links a customer to a GitHub subject when the workspace owner explicitly names the GitHub account. Phase 5 replaces that link with the verified claim flow; an unverified email match still never grants access.
- **Time-based changes** use `next_evaluation_at` on subscriptions, swept every minute by the jobs cron, which then re-reads the source. The planner also treats `valid_until <= now` as not desired, so a late sweep never extends access. Phase 6 may replace the sweep with Workflows.

## Consequences

- Creators choose their own trade-off between churn and goodwill. The access view shows the grace deadline.
- Changing an offer's grace period applies to future decisions. The next recompute re-evaluates existing past-due subscriptions against the new version, and their entitlements record which version they were decided under.
- Phase 5 adds a Paddle implementation of the port and the claim flow. Neither requires a change to the policy, the planner or the schema for entitlements.

## Amendment — expiry is confirmed before revocation (Phase 6 T2)

[Decision 0013](0013-database-timers-and-expiry-confirmation.md) replaces "the planner treats `valid_until <= now` as not desired". An `active` entitlement past `valid_until` is **expiry pending** for `EXPIRY_CONFIRMATION_WINDOW_MS` (6 hours): reconciliation neither grants nor revokes for it while the subscription's refresh re-reads the source. It is not desired once the window has passed or once it is `expired`. Time-based changes still use `next_evaluation_at` and the minute sweep; Workflows are not used.
