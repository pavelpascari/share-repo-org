import { describe, expect, it } from "vitest";
import {
  ACCESS_DECISION_REASONS,
  ACCESS_LEVELS,
  ACCESS_POLICY_VERSION,
  ALERT_NAMES,
  AlertName,
  AUDIT_ACTOR_TYPES,
  AUDIT_SCOPES,
  CLAIM_REJECTION_REASONS,
  ClaimRejectionReason,
  COMMERCIAL_SOURCES,
  CONNECTABLE_ACCOUNT_TYPES,
  CONNECTION_STATUSES,
  CREDENTIAL_KINDS,
  CredentialKind,
  ENTITLEMENT_SOURCE_TYPES,
  ENTITLEMENT_STATES,
  ENTITLEMENT_VALIDITIES,
  EntitlementValidity,
  EVENT_PROVIDERS,
  EventProvider,
  EXPIRY_CONFIRMATION_WINDOW_MS,
  EXTERNAL_EVENT_STATES,
  GRACE_PERIOD_DAYS_DEFAULT,
  GRACE_PERIOD_DAYS_MAX,
  GRACE_PERIOD_DAYS_MIN,
  GRANT_ERROR_CODES,
  GRANT_STATES,
  IDENTITY_PROVIDERS,
  INVITATION_BUDGET,
  INVITATION_LIFETIME_MS,
  INVITATION_WINDOW_MS,
  LINK_PATHS,
  LinkPath,
  MANUAL_ACCESS_NOTE_MAX_LENGTH,
  MANUAL_ACCESS_OPEN_LIMIT,
  MANUAL_ACCESS_RATE_LIMIT,
  MANUAL_ACCESS_REVOKE_CAUSES,
  MAX_MUTATIONS_PER_RUN,
  ManualAccessRevokeCause,
  ManualAccessStatus,
  MUTATION_OPERATIONS,
  MUTATION_STATUSES,
  MUTATION_STOP_REASONS,
  OBSERVATION_ERROR_CODES,
  OBSERVATION_GRACE_MS,
  OFFER_ACCESSES_MAX,
  OFFER_CHANGES,
  OFFER_ITEMS_MAX,
  OFFER_NAME_MAX_LENGTH,
  OFFER_STATUSES,
  OUTBOX_KINDS,
  OutboxKind,
  PADDLE_BILLING_INTERVALS,
  PADDLE_CONNECTION_STATUSES,
  PADDLE_ENVIRONMENTS,
  PADDLE_PRICE_STATUSES,
  PaddleBillingInterval,
  PaddleConnectionStatus,
  PaddleEnvironment,
  PaddlePriceStatus,
  PROVIDER_FAILURE_KINDS,
  RECONCILE_IDLE_MS,
  RECONCILE_POLL_MS,
  RECONCILIATION_ACTIONS,
  RECONCILIATION_REASONS,
  RECONCILIATION_REQUEST_KINDS,
  RESOURCE_SELECTIONS,
  RESOURCE_TYPES,
  RETRY_BACKOFF_MS,
  RETRY_CLASSES,
  SIGN_IN_REFUSAL_REASONS,
  SUBJECT_TYPES,
  SUBSCRIPTION_STATES,
  SWEEP_LAG_ALERT_INTERVAL_MS,
  SWEEP_LAG_ALERT_MS,
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
      "send_claim_email",
      "check_paddle_connection",
      "sweep_paddle_subscriptions",
      "prune_data",
      "purge_workspace",
      "rewrap_credentials",
    ]));
  it("outbox kinds by name", () => expect(Object.values(OutboxKind)).toEqual(OUTBOX_KINDS));
  it("event providers", () => expect(EVENT_PROVIDERS).toEqual(["github", "paddle"]));
  it("event providers by name", () =>
    expect(Object.values(EventProvider)).toEqual(EVENT_PROVIDERS));
  it("paddle connection statuses", () =>
    expect(PADDLE_CONNECTION_STATUSES).toEqual(["active", "unauthorized", "disconnected"]));
  it("paddle connection statuses by name", () =>
    expect(Object.values(PaddleConnectionStatus)).toEqual(PADDLE_CONNECTION_STATUSES));
  it("paddle environments", () => expect(PADDLE_ENVIRONMENTS).toEqual(["sandbox", "live"]));
  it("paddle environments by name", () =>
    expect(Object.values(PaddleEnvironment)).toEqual(PADDLE_ENVIRONMENTS));
  it("paddle price statuses", () => expect(PADDLE_PRICE_STATUSES).toEqual(["active", "archived"]));
  it("paddle price statuses by name", () =>
    expect(Object.values(PaddlePriceStatus)).toEqual(PADDLE_PRICE_STATUSES));
  it("paddle billing intervals", () =>
    expect(PADDLE_BILLING_INTERVALS).toEqual(["day", "week", "month", "year"]));
  it("paddle billing intervals by name", () =>
    expect(Object.values(PaddleBillingInterval)).toEqual(PADDLE_BILLING_INTERVALS));
  it("credential kinds", () => expect(CREDENTIAL_KINDS).toEqual(["api_key", "oauth"]));
  it("credential kinds by name", () =>
    expect(Object.values(CredentialKind)).toEqual(CREDENTIAL_KINDS));
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
  it("entitlement source types", () =>
    expect(ENTITLEMENT_SOURCE_TYPES).toEqual(["subscription", "manual"]));
  it("manual access revoke causes", () =>
    expect(MANUAL_ACCESS_REVOKE_CAUSES).toEqual(["owner", "account_deleted"]));
  it("manual access revoke causes by name", () =>
    expect(Object.values(ManualAccessRevokeCause)).toEqual(MANUAL_ACCESS_REVOKE_CAUSES));
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
      "workspace_deleted",
      "account_deleted",
      "manual",
      "manual_ended",
      "manual_revoked",
    ]));
  it("manual access statuses", () =>
    expect(Object.values(ManualAccessStatus)).toEqual(["active", "ended", "revoked"]));
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
      "expiry_pending",
    ]));
  it("grant error codes", () =>
    expect(GRANT_ERROR_CODES).toEqual([
      "provider_unavailable",
      "rate_limited",
      "invitation_rejected",
      "app_permission_missing",
      "account_not_found",
      "provider_rejected",
    ]));
  it("mutation stop reasons", () =>
    expect(MUTATION_STOP_REASONS).toEqual([
      "suspended",
      "repository_not_found",
      "installation_missing",
    ]));
  it("observation error codes", () =>
    expect(OBSERVATION_ERROR_CODES).toEqual([
      "provider_unavailable",
      "rate_limited",
      "provider_rejected",
      "malformed_response",
      "suspended",
      "repository_not_found",
      "installation_missing",
    ]));
  it("reconciliation request kinds", () =>
    expect(RECONCILIATION_REQUEST_KINDS).toEqual(["check", "retry"]));
  it("claim link paths (decision 0012)", () =>
    expect(LINK_PATHS).toEqual(["checkout", "email", "manual"]));
  it("claim link paths by name", () => expect(Object.values(LinkPath)).toEqual(LINK_PATHS));
  it("claim rejection reasons", () =>
    expect(CLAIM_REJECTION_REASONS).toEqual([
      "signature_invalid",
      "unknown_claim",
      "other_workspace",
      "expired",
      "consumed_by_other_customer",
      "already_used",
      "customer_has_other_purchases",
    ]));
  it("claim rejection reasons by name", () =>
    expect(Object.values(ClaimRejectionReason)).toEqual(CLAIM_REJECTION_REASONS));
  it("offer limits", () =>
    expect([OFFER_NAME_MAX_LENGTH, OFFER_ITEMS_MAX, OFFER_ACCESSES_MAX]).toEqual([100, 100, 100]));
  it("manual access limits", () =>
    expect([
      MANUAL_ACCESS_NOTE_MAX_LENGTH,
      MANUAL_ACCESS_OPEN_LIMIT,
      MANUAL_ACCESS_RATE_LIMIT,
    ]).toEqual([500, 100, { windowMs: 86_400_000, limit: 50 }]));
});

// Provider-neutral failure kinds that adapters map their errors to.
// Monitors match these names in log lines (decision 0014); renaming one silences its alert.
describe("alert names", () => {
  it("lists them", () =>
    expect(ALERT_NAMES).toEqual([
      "job_failed",
      "reconcile_failing",
      "connection_lost",
      "sweep_lagging",
    ]));
  it("by name", () => expect(Object.values(AlertName)).toEqual(ALERT_NAMES));
});

describe("provider failure kinds", () => {
  it("lists them", () =>
    expect(PROVIDER_FAILURE_KINDS).toEqual([
      "not_found",
      "suspended",
      "rate_limited",
      "transient",
      "rejected",
      "malformed_response",
    ]));
});

// Provisioning limits and timing (decision 0010, phase 4 plan).
describe("provisioning constants", () => {
  const MINUTE = 60_000;
  const HOUR = 60 * MINUTE;
  it("invitations", () =>
    expect([INVITATION_LIFETIME_MS, INVITATION_BUDGET, INVITATION_WINDOW_MS]).toEqual([
      7 * 24 * HOUR,
      40,
      24 * HOUR,
    ]));
  it("runs", () =>
    expect([
      OBSERVATION_GRACE_MS,
      MAX_MUTATIONS_PER_RUN,
      RECONCILE_POLL_MS,
      RECONCILE_IDLE_MS,
    ]).toEqual([5 * MINUTE, 10, 15 * MINUTE, 6 * HOUR]));
  it("retry backoff", () =>
    expect(RETRY_BACKOFF_MS).toEqual([1 * MINUTE, 5 * MINUTE, 15 * MINUTE, 60 * MINUTE]));
});

// Expiry confirmation and sweep health (decisions 0013 and 0014).
describe("timing constants", () => {
  const MINUTE = 60_000;
  it("expiry confirmation window", () =>
    expect(EXPIRY_CONFIRMATION_WINDOW_MS).toBe(6 * 60 * MINUTE));
  it("entitlement validities", () =>
    expect(ENTITLEMENT_VALIDITIES).toEqual(["desired", "expiry_pending", "not_desired"]));
  it("entitlement validities by name", () =>
    expect(Object.values(EntitlementValidity)).toEqual(ENTITLEMENT_VALIDITIES));
  it("sweep lag alert", () =>
    expect([SWEEP_LAG_ALERT_MS, SWEEP_LAG_ALERT_INTERVAL_MS]).toEqual([15 * MINUTE, 15 * MINUTE]));
});
