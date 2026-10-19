import { describe, expect, it } from "vitest";
import {
  ACCESS_DECISION_REASONS,
  ACCESS_LEVELS,
  ACCESS_POLICY_VERSION,
  AUDIT_ACTOR_TYPES,
  AUDIT_SCOPES,
  COMMERCIAL_SOURCES,
  CONNECTABLE_ACCOUNT_TYPES,
  CONNECTION_STATUSES,
  ENTITLEMENT_SOURCE_TYPES,
  ENTITLEMENT_STATES,
  EXTERNAL_EVENT_STATES,
  GRACE_PERIOD_DAYS_DEFAULT,
  GRACE_PERIOD_DAYS_MAX,
  GRACE_PERIOD_DAYS_MIN,
  GRANT_STATES,
  IDENTITY_PROVIDERS,
  MUTATION_OPERATIONS,
  MUTATION_STATUSES,
  OFFER_ACCESSES_MAX,
  OFFER_CHANGES,
  OFFER_ITEMS_MAX,
  OFFER_NAME_MAX_LENGTH,
  OFFER_STATUSES,
  OUTBOX_KINDS,
  OutboxKind,
  RECONCILIATION_ACTIONS,
  RECONCILIATION_REASONS,
  RESOURCE_SELECTIONS,
  RESOURCE_TYPES,
  RETRY_CLASSES,
  SIGN_IN_REFUSAL_REASONS,
  SUBJECT_TYPES,
  SUBSCRIPTION_STATES,
} from "../src/index.ts";

// These lists feed database CHECK constraints; changing one needs a migration.
describe("persisted vocabularies", () => {
  it("audit scopes", () => expect(AUDIT_SCOPES).toEqual(["workspace", "account"]));
  it("audit actor types", () =>
    expect(AUDIT_ACTOR_TYPES).toEqual(["user", "system", "operator", "provider"]));
  it("identity providers", () => expect(IDENTITY_PROVIDERS).toEqual(["github"]));
  it("sign-in refusal reasons", () =>
    expect(SIGN_IN_REFUSAL_REASONS).toEqual(["identity_conflict", "internal_error"]));
  it("connection statuses", () =>
    expect(CONNECTION_STATUSES).toEqual(["active", "suspended", "deleted"]));
  it("connectable account types", () => expect(CONNECTABLE_ACCOUNT_TYPES).toEqual(["user"]));
  it("resource types", () => expect(RESOURCE_TYPES).toEqual(["repository"]));
  it("resource selections", () => expect(RESOURCE_SELECTIONS).toEqual(["selected", "removed"]));
  it("external event states", () =>
    expect(EXTERNAL_EVENT_STATES).toEqual(["pending", "processed", "ignored", "failed"]));
  it("outbox kinds", () =>
    expect(OUTBOX_KINDS).toEqual([
      "process_external_event",
      "resync_connection",
      "refresh_subscription",
      "recompute_offer",
      "reconcile_resource",
    ]));
  it("outbox kinds by name", () => expect(Object.values(OutboxKind)).toEqual(OUTBOX_KINDS));
  it("offer statuses", () => expect(OFFER_STATUSES).toEqual(["active", "archived"]));
  it("grace period bounds (decision 0009)", () =>
    expect([GRACE_PERIOD_DAYS_MIN, GRACE_PERIOD_DAYS_DEFAULT, GRACE_PERIOD_DAYS_MAX]).toEqual([
      0, 7, 30,
    ]));
  it("commercial sources", () => expect(COMMERCIAL_SOURCES).toEqual(["simulated", "paddle"]));
  it("subscription states", () =>
    expect(SUBSCRIPTION_STATES).toEqual([
      "trialing",
      "active",
      "past_due",
      "paused",
      "canceled",
      "expired",
    ]));
  it("entitlement states", () =>
    expect(ENTITLEMENT_STATES).toEqual(["active", "expired", "revoked"]));
  it("entitlement source types", () => expect(ENTITLEMENT_SOURCE_TYPES).toEqual(["subscription"]));
  it("access levels", () => expect(ACCESS_LEVELS).toEqual(["read", "write"]));
  it("access policy version", () => expect(ACCESS_POLICY_VERSION).toBe(1));
  it("grant states", () =>
    expect(GRANT_STATES).toEqual([
      "unknown",
      "absent",
      "provisioning",
      "pending_invitation",
      "active",
      "revoking",
      "error",
    ]));
  it("retry classes", () =>
    expect(RETRY_CLASSES).toEqual([
      "retryable",
      "rate_limited",
      "user_action_required",
      "terminal",
    ]));
  it("subject types", () => expect(SUBJECT_TYPES).toEqual(["user"]));
  it("mutation operations", () =>
    expect(MUTATION_OPERATIONS).toEqual(["invite", "remove_collaborator", "cancel_invitation"]));
  it("mutation statuses", () =>
    expect(MUTATION_STATUSES).toEqual(["started", "succeeded", "failed", "resolved"]));
});

// Stored in entitlements, audit details and shown in the UI: add codes, never rename them.
describe("stable decision codes", () => {
  it("access decision reasons", () =>
    expect(ACCESS_DECISION_REASONS).toEqual([
      "active",
      "trialing",
      "cancel_scheduled",
      "past_due_in_grace",
      "canceled_until_end",
      "paused",
      "grace_expired",
      "cancellation_effective",
      "canceled",
      "expired",
      "offer_archived",
      "offer_access_removed",
      "offer_access_changed",
      "item_removed",
      "customer_unlinked",
      "subscription_missing",
    ]));
  it("offer changes", () =>
    expect(OFFER_CHANGES).toEqual(["name", "gracePeriodDays", "items", "accesses"]));
  it("reconciliation actions", () =>
    expect(RECONCILIATION_ACTIONS).toEqual([
      "provision",
      "verify",
      "wait",
      "retry",
      "request_action",
      "blocked",
      "revoke",
      "noop",
    ]));
  it("reconciliation reasons", () =>
    expect(RECONCILIATION_REASONS).toEqual([
      "grant_missing",
      "access_level_change",
      "invitation_expired",
      "grant_active",
      "intermediate_state",
      "invitation_pending",
      "transient_error",
      "rate_limited",
      "user_action_required",
      "terminal_error",
      "unmanaged_lower_access",
      "resource_missing",
      "connection_inactive",
      "resource_unavailable",
      "access_level_unsupported",
      "not_entitled",
      "revocation_in_progress",
      "unmanaged_access",
      "no_access",
      "invitation_quota",
      "indirect_access",
    ]));
  it("offer limits", () =>
    expect([OFFER_NAME_MAX_LENGTH, OFFER_ITEMS_MAX, OFFER_ACCESSES_MAX]).toEqual([100, 100, 100]));
});
