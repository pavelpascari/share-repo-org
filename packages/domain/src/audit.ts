import { z } from "zod";
import {
  CHECKOUT_REJECTION_REASONS,
  CLAIM_REJECTION_REASONS,
  EMAIL_REJECTION_REASONS,
  LinkPath,
} from "./claim.ts";
import { CONNECTION_STATUSES } from "./connection.ts";
import { ACCESS_LEVELS } from "./entitlement.ts";
import { OUTBOX_KINDS } from "./external-event.ts";
import { GRANT_STATES, MUTATION_OPERATIONS, RETRY_CLASSES } from "./grant.ts";
import { IDENTITY_PROVIDERS } from "./identity.ts";
import type { IdGenerator } from "./ids.ts";
import { COMMERCIAL_SOURCES, GRACE_PERIOD_DAYS_MAX, GRACE_PERIOD_DAYS_MIN } from "./offer.ts";
import { PADDLE_ENVIRONMENTS, PaddleConnectionStatus } from "./paddle.ts";
import { ACCESS_DECISION_REASONS } from "./policy.ts";
import { GRANT_ERROR_CODES, MUTATION_STOP_REASONS } from "./provisioning.ts";
import { RESOURCE_SELECTIONS } from "./resource.ts";
import { SUBSCRIPTION_STATES } from "./subscription.ts";
import type { Clock, Instant } from "./time.ts";
import { WORKSPACE_ROLES } from "./workspace.ts";

/** Audit events are either about one workspace or about a user's account (decision 0007). */
export const AUDIT_SCOPES = ["workspace", "account"] as const;
export type AuditScope = (typeof AUDIT_SCOPES)[number];

/** Who or what initiated an audited change. */
export const AUDIT_ACTOR_TYPES = ["user", "system", "operator", "provider"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * A persisted audit event (decision 0007). Build one with the action catalog rather than by hand,
 * so `scope`, `target.type` and `details` always match the action's definition.
 */
export interface AuditEvent {
  readonly id: string;
  readonly scope: AuditScope;
  /** Set for workspace-scoped events, null for account-scoped events. */
  readonly workspaceId: string | null;
  readonly actor: { readonly type: AuditActorType; readonly id: string | null };
  readonly action: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly reason: string | null;
  readonly correlationId: string;
  readonly occurredAt: Instant;
  /** Never secrets, tokens or email addresses. */
  readonly details: Readonly<Record<string, unknown>>;
}

interface AuditActionDefinition {
  /**
   * `either`: the event is in the workspace when there is one and account-scoped otherwise, such
   * as a failed job, which may be system-wide (decision 0014). The caller passes the workspace ID
   * or null explicitly.
   */
  readonly scope: AuditScope | "either";
  readonly targetType: string;
  readonly details: z.ZodObject;
  /** The event must carry a human reason, such as an owner's justification for a manual link. */
  readonly requiresReason?: true;
}

const text = z.string().min(1);
const count = z.number().int().nonnegative();
const provider = z.enum(IDENTITY_PROVIDERS);
const connectionStatus = z.enum(CONNECTION_STATUSES);
const selection = z.enum(RESOURCE_SELECTIONS);
const positive = z.number().int().positive();
const instant = z.number().int().nonnegative();
const gracePeriodDays = z.number().int().min(GRACE_PERIOD_DAYS_MIN).max(GRACE_PERIOD_DAYS_MAX);
const source = z.enum(COMMERCIAL_SOURCES);
const subscriptionState = z.enum(SUBSCRIPTION_STATES);
const decisionReason = z.enum(ACCESS_DECISION_REASONS);
const accessLevel = z.enum(ACCESS_LEVELS);
const grantState = z.enum(GRANT_STATES);
/** A Paddle connection status other than `disconnected`, which is final. */
const liveConnectionStatus = z.enum([
  PaddleConnectionStatus.Active,
  PaddleConnectionStatus.Unauthorized,
]);
/** The self-service claim paths; an owner's manual link has its own action. */
const claimPath = z.enum([LinkPath.Checkout, LinkPath.Email]);
const outboxKind = z.enum(OUTBOX_KINDS);
/** Rows deleted per table, by table name: counts only, never row contents (decision 0015). */
const deletedRows = z.record(z.string().regex(/^[a-z][a-z0-9_]*$/), count);

/** The grant fields a `grant.observed` event reports, before and after. */
const observedGrant = z.strictObject({
  state: grantState,
  managed: z.boolean(),
  indirect: z.boolean(),
  accessLevel,
});

/**
 * Every `provider.mutation_*` event names the mutation, what it changes, and the decision's
 * entitlements (integrations.md § Reconciliation ownership). External IDs are the provider's
 * immutable IDs, never logins.
 */
const mutation = {
  mutationId: text,
  operation: z.enum(MUTATION_OPERATIONS),
  resourceId: text,
  subjectId: text,
  resourceExternalId: text,
  subjectExternalId: text,
  accessLevel,
  // Empty for a revocation: no access is desired.
  entitlementIds: z.array(text).readonly(),
};

/** What a reconciliation request asked for: a check of the repository, or a grant's retry. */
export const RECONCILIATION_REQUEST_KINDS = ["check", "retry"] as const;
export type ReconciliationRequestKind = (typeof RECONCILIATION_REQUEST_KINDS)[number];

/** The parts of an offer's configuration an `offer.updated` event says changed. */
export const OFFER_CHANGES = ["name", "gracePeriodDays", "items", "accesses"] as const;
export type OfferChange = (typeof OFFER_CHANGES)[number];

const textChange = z.strictObject({ from: text, to: text });
const booleanChange = z.strictObject({ from: z.boolean(), to: z.boolean() });

/** Mirrors `ResourceChanges` in resource-sync.ts: at least one field, each as from/to. */
const resourceChanges = z
  .strictObject({
    name: textChange.optional(),
    ownerExternalId: textChange.optional(),
    private: booleanChange.optional(),
    archived: booleanChange.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0);

/** Why a sign-in that authenticated with the provider was refused anyway. */
export const SIGN_IN_REFUSAL_REASONS = ["identity_conflict", "internal_error"] as const;
export type SignInRefusalReason = (typeof SIGN_IN_REFUSAL_REASONS)[number];

// Details schemas are strict: an unknown key is rejected rather than stored, so a secret cannot
// reach the audit trail through an unvetted field.
export const AUDIT_ACTIONS = {
  "user.created": { scope: "account", targetType: "user", details: z.strictObject({}) },
  "identity.linked": {
    scope: "account",
    targetType: "external_identity",
    details: z.strictObject({ provider, externalUserId: text, username: text }),
  },
  "identity.snapshot_updated": {
    scope: "account",
    targetType: "external_identity",
    details: z.strictObject({
      provider,
      externalUserId: text,
      previousUsername: text,
      username: text,
    }),
  },
  "auth.signed_in": {
    scope: "account",
    targetType: "user",
    details: z.strictObject({ provider }),
  },
  "auth.signed_out": { scope: "account", targetType: "user", details: z.strictObject({}) },
  "auth.sign_in_refused": {
    scope: "account",
    targetType: "user",
    details: z.strictObject({ provider, reason: z.enum(SIGN_IN_REFUSAL_REASONS) }),
  },
  "workspace.created": {
    scope: "workspace",
    targetType: "workspace",
    details: z.strictObject({ slug: text, name: text }),
  },
  "workspace.renamed": {
    scope: "workspace",
    targetType: "workspace",
    details: z.strictObject({ previousName: text, name: text }),
  },
  "membership.added": {
    scope: "workspace",
    targetType: "user",
    details: z.strictObject({ role: z.enum(WORKSPACE_ROLES) }),
  },
  "connection.intent_created": {
    scope: "workspace",
    targetType: "connection_intent",
    details: z.strictObject({ provider }),
  },
  "connection.created": {
    scope: "workspace",
    targetType: "connection",
    details: z.strictObject({ provider, installationId: text, accountLogin: text }),
  },
  "connection.status_changed": {
    scope: "workspace",
    targetType: "connection",
    details: z
      .strictObject({ previousStatus: connectionStatus, status: connectionStatus })
      // A transition must change something; the issue names the new value's field.
      .refine((d) => d.previousStatus !== d.status, { path: ["status"] }),
  },
  // Written by every resync, so its bookkeeping (last_synced_at) is audited too.
  "connection.synced": {
    scope: "workspace",
    targetType: "connection",
    details: z.strictObject({ discovered: count, updated: count, removed: count }),
  },
  "resource.discovered": {
    scope: "workspace",
    targetType: "resource",
    details: z.strictObject({ externalId: text, name: text, private: z.boolean() }),
  },
  "resource.updated": {
    scope: "workspace",
    targetType: "resource",
    details: z.strictObject({ externalId: text, changes: resourceChanges }),
  },
  "resource.selection_changed": {
    scope: "workspace",
    targetType: "resource",
    details: z
      .strictObject({ externalId: text, previousSelection: selection, selection })
      .refine((d) => d.previousSelection !== d.selection, { path: ["selection"] }),
  },
  "offer.created": {
    scope: "workspace",
    targetType: "offer",
    details: z.strictObject({
      name: text,
      version: positive,
      gracePeriodDays,
      items: count,
      accesses: count,
    }),
  },
  "offer.updated": {
    scope: "workspace",
    targetType: "offer",
    details: z
      .strictObject({
        version: positive,
        previousVersion: positive,
        changes: z.array(z.enum(OFFER_CHANGES)).min(1),
      })
      .refine((d) => d.version === d.previousVersion + 1, { path: ["version"] }),
  },
  "offer.archived": {
    scope: "workspace",
    targetType: "offer",
    details: z.strictObject({ version: positive }),
  },
  "subject.created": {
    scope: "workspace",
    targetType: "subject",
    details: z.strictObject({ provider, externalSubjectId: text, login: text }),
  },
  "subject.login_updated": {
    scope: "workspace",
    targetType: "subject",
    details: z
      .strictObject({ provider, externalSubjectId: text, previousLogin: text, login: text })
      .refine((d) => d.previousLogin !== d.login, { path: ["login"] }),
  },
  "customer.created": {
    scope: "workspace",
    targetType: "customer",
    details: z.strictObject({ source, externalCustomerId: text }),
  },
  "customer.linked": {
    scope: "workspace",
    targetType: "customer",
    details: z
      .strictObject({ previousSubjectId: text.nullable(), subjectId: text.nullable() })
      .refine((d) => d.previousSubjectId !== d.subjectId, { path: ["subjectId"] }),
  },
  "subscription.recorded": {
    scope: "workspace",
    targetType: "subscription",
    details: z.strictObject({ source, externalSubscriptionId: text, state: subscriptionState }),
  },
  "subscription.updated": {
    scope: "workspace",
    targetType: "subscription",
    details: z.strictObject({
      previousState: subscriptionState,
      state: subscriptionState,
      sourceUpdatedAt: instant,
    }),
  },
  "entitlement.created": {
    scope: "workspace",
    targetType: "entitlement",
    details: z.strictObject({
      subjectId: text,
      resourceId: text,
      accessLevel: z.enum(ACCESS_LEVELS),
      subscriptionId: text,
      offerId: text,
      offerVersion: positive,
      policyVersion: positive,
      validUntil: instant.nullable(),
      reason: decisionReason,
    }),
  },
  "entitlement.updated": {
    scope: "workspace",
    targetType: "entitlement",
    details: z.strictObject({
      validUntil: z.strictObject({ from: instant.nullable(), to: instant.nullable() }),
      reason: decisionReason,
      offerVersion: positive,
      policyVersion: positive,
    }),
  },
  "entitlement.ended": {
    scope: "workspace",
    targetType: "entitlement",
    details: z.strictObject({ state: z.enum(["expired", "revoked"]), reason: decisionReason }),
  },
  "simulation.subscription_changed": {
    scope: "workspace",
    targetType: "simulated_subscription",
    details: z.strictObject({ action: text, state: subscriptionState }),
  },
  // Only when the state, ownership, indirectness or level changes; `from` is null for a new grant.
  "grant.observed": {
    scope: "workspace",
    targetType: "grant",
    details: z
      .strictObject({
        resourceId: text,
        subjectId: text,
        from: observedGrant.nullable(),
        to: observedGrant,
      })
      .refine(
        ({ from, to }) =>
          from === null ||
          from.state !== to.state ||
          from.managed !== to.managed ||
          from.indirect !== to.indirect ||
          from.accessLevel !== to.accessLevel,
        { path: ["to"] },
      ),
  },
  "provider.mutation_attempted": {
    scope: "workspace",
    targetType: "grant",
    details: z.strictObject(mutation),
  },
  "provider.mutation_succeeded": {
    scope: "workspace",
    targetType: "grant",
    details: z.strictObject(mutation),
  },
  // A failure that stops the run leaves the grant unchanged, so it has no retry class.
  "provider.mutation_failed": {
    scope: "workspace",
    targetType: "grant",
    details: z.strictObject({
      ...mutation,
      errorCode: z.enum([...GRANT_ERROR_CODES, ...MUTATION_STOP_REASONS]),
      retryClass: z.enum(RETRY_CLASSES).nullable(),
    }),
  },
  // A `started` mutation whose outcome a later observation settled (a lost response or a crash).
  "provider.mutation_resolved": {
    scope: "workspace",
    targetType: "grant",
    details: z.strictObject({ ...mutation, state: grantState }),
  },
  "reconciliation.requested": {
    scope: "workspace",
    targetType: "resource",
    details: z.strictObject({
      resourceId: text,
      grantId: text.optional(),
      kind: z.enum(RECONCILIATION_REQUEST_KINDS),
    }),
  },
  // Paddle connections and claims (Phase 5, decisions 0011 and 0012). Details carry IDs only:
  // never an email, token, claim reference or key.
  "paddle.connected": {
    scope: "workspace",
    targetType: "paddle_connection",
    details: z.strictObject({ environment: z.enum(PADDLE_ENVIRONMENTS), sellerId: text }),
  },
  // A new key for the same seller. `destinationRecreated` is true when the destination had been
  // deleted outside ShareRepo and a new one was created.
  "paddle.reconnected": {
    scope: "workspace",
    targetType: "paddle_connection",
    details: z.strictObject({
      sellerId: text,
      previousStatus: liveConnectionStatus,
      destinationRecreated: z.boolean(),
    }),
  },
  "paddle.disconnected": {
    scope: "workspace",
    targetType: "paddle_connection",
    // False when the destination could not be deleted and the creator must delete it in Paddle.
    details: z.strictObject({
      previousStatus: liveConnectionStatus,
      destinationDeleted: z.boolean(),
    }),
  },
  // Between active and unauthorized only: disconnecting has its own action. The classified
  // status reason, when there is one, is the event's `reason`.
  "paddle.status_changed": {
    scope: "workspace",
    targetType: "paddle_connection",
    details: z
      .strictObject({ previousStatus: liveConnectionStatus, status: liveConnectionStatus })
      .refine((d) => d.previousStatus !== d.status, { path: ["status"] }),
  },
  // An envelope sealed under a retired master key was re-sealed under the current one (decision
  // 0011, rotation). The secret itself is unchanged; `field` names which envelope:
  // `webhook_secret_next` is the secret of a webhook rotation in progress.
  "paddle.credentials_rewrapped": {
    scope: "workspace",
    targetType: "paddle_connection",
    details: z.strictObject({
      field: z.enum(["api_key", "webhook_secret", "webhook_secret_next"]),
    }),
  },
  "paddle.catalog_synced": {
    scope: "workspace",
    targetType: "paddle_connection",
    details: z.strictObject({ added: count, updated: count, archived: count }),
  },
  "checkout.started": {
    scope: "workspace",
    targetType: "checkout_claim",
    details: z.strictObject({ offerId: text, priceId: text }),
  },
  // The same shape whether or not a purchase matches (threat T4).
  "claim.requested": {
    scope: "workspace",
    targetType: "claim_request",
    details: z.strictObject({}),
  },
  "claim.token_issued": {
    scope: "workspace",
    targetType: "claim_token",
    details: z.strictObject({ claimRequestId: text, customerId: text }),
  },
  // A claim linked the customer, or found it already linked to the claimant's subject. `claimId`
  // is the checkout claim's (path 1) or the claim token's (path 2) ID.
  "claim.completed": {
    scope: "workspace",
    targetType: "customer",
    details: z.strictObject({ path: claimPath, claimId: text, userId: text, subjectId: text }),
  },
  // `claimId` is null when no claim was identified: a reference that does not verify, or a token
  // that matches nothing. Each path has its own reasons.
  "claim.rejected": {
    scope: "workspace",
    targetType: "customer",
    details: z
      .strictObject({
        path: claimPath,
        claimId: text.nullable(),
        reason: z.enum(CLAIM_REJECTION_REASONS),
      })
      .refine(
        (d) =>
          (d.path === LinkPath.Checkout
            ? (CHECKOUT_REJECTION_REASONS as readonly string[])
            : (EMAIL_REJECTION_REASONS as readonly string[])
          ).includes(d.reason),
        { path: ["reason"] },
      ),
  },
  // Path 1 never moves an existing link (decideCustomerLink): the linked subject and the
  // claimant's user are recorded, and the link stays.
  "claim.conflict": {
    scope: "workspace",
    targetType: "customer",
    details: z.strictObject({
      path: z.literal(LinkPath.Checkout),
      claimId: text,
      subjectId: text,
      userId: text,
    }),
  },
  // Path 2 moved the link; path 3 records `customer.linked_manually` instead.
  "customer.relinked": {
    scope: "workspace",
    targetType: "customer",
    details: z
      .strictObject({
        path: z.literal(LinkPath.Email),
        previousSubjectId: text,
        subjectId: text,
      })
      .refine((d) => d.previousSubjectId !== d.subjectId, { path: ["subjectId"] }),
  },
  // The owner's reason is the event's `reason`, which is required.
  "customer.linked_manually": {
    scope: "workspace",
    targetType: "customer",
    requiresReason: true,
    details: z
      .strictObject({ previousSubjectId: text.nullable(), subjectId: text })
      .refine((d) => d.previousSubjectId !== d.subjectId, { path: ["subjectId"] }),
  },
  // Failures, operators and the data lifecycle (Phase 6, decisions 0014 and 0015). Minimal shapes
  // from Phase 6 T1, refined by the tasks that write them. IDs, counts and codes only: never a
  // login, email, secret or key ID. A job is in its workspace when it has one (`outbox.workspace_id`).
  "job.failed": {
    scope: "either",
    targetType: "outbox",
    details: z.strictObject({
      kind: outboxKind,
      subjectId: text,
      errorCode: text,
      attempts: count,
    }),
  },
  "job.retried": {
    scope: "either",
    targetType: "outbox",
    details: z.strictObject({ kind: outboxKind, previousErrorCode: text }),
  },
  // The dismissal reason is the event's `reason`, which is required.
  "job.dismissed": {
    scope: "either",
    targetType: "outbox",
    requiresReason: true,
    details: z.strictObject({ kind: outboxKind, errorCode: text }),
  },
  // An operator read a workspace's page; the actor is the operator.
  "operator.viewed_workspace": {
    scope: "workspace",
    targetType: "workspace",
    details: z.strictObject({}),
  },
  // One per pruning run, a system event (decision 0015).
  "data.pruned": {
    scope: "account",
    targetType: "retention_run",
    details: z.strictObject({ deleted: deletedRows }),
  },
  "workspace.exported": {
    scope: "workspace",
    targetType: "workspace",
    details: z.strictObject({ formatVersion: positive }),
  },
  "workspace.deletion_requested": {
    scope: "workspace",
    targetType: "workspace",
    details: z.strictObject({ deleteAfter: instant }),
  },
  "workspace.deletion_cancelled": {
    scope: "workspace",
    targetType: "workspace",
    details: z.strictObject({}),
  },
  // The tombstone written after the workspace's own audit events are gone: the target is the
  // workspace ID, the details only counts.
  "workspace.purged": {
    scope: "account",
    targetType: "workspace",
    details: z.strictObject({ deleted: deletedRows }),
  },
  "user.deleted": {
    scope: "account",
    targetType: "user",
    details: z.strictObject({ unlinkedSubjects: count, deleted: deletedRows }),
  },
  // A webhook secret rotation (Phase 6): `started` once the second destination and its secret are
  // stored and both secrets are accepted; `completed` once the old destination is deleted and the
  // new one promoted. `destinationId` is the new destination in both.
  "paddle.webhook_secret_rotated": {
    scope: "workspace",
    targetType: "paddle_connection",
    details: z
      .strictObject({
        stage: z.enum(["started", "completed"]),
        previousDestinationId: text,
        destinationId: text,
      })
      .refine((d) => d.previousDestinationId !== d.destinationId, { path: ["destinationId"] }),
  },
  // One per rewrap run over every workspace's envelopes (secret rotation): envelopes moved to the
  // current master key, those that could not be opened, and those still under another listed key.
  "credentials.rewrapped": {
    scope: "account",
    targetType: "rewrap_run",
    details: z.strictObject({ rewrapped: count, failed: count, remaining: count }),
  },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
type Definition<A extends AuditAction> = (typeof AUDIT_ACTIONS)[A];
export type AuditDetails<A extends AuditAction> = z.input<Definition<A>["details"]>;

/**
 * A workspace ID is required for workspace-scoped actions and not allowed for account-scoped
 * ones. An `either` action takes the workspace ID, or an explicit null when there is none.
 */
type WorkspaceField<A extends AuditAction> = Definition<A>["scope"] extends "workspace"
  ? { readonly workspaceId: string }
  : Definition<A>["scope"] extends "account"
    ? { readonly workspaceId?: never }
    : { readonly workspaceId: string | null };

/** A reason is required for actions that demand one and optional for the rest. */
type ReasonField<A extends AuditAction> =
  Definition<A> extends { readonly requiresReason: true }
    ? { readonly reason: string }
    : { readonly reason?: string };

export type AuditEventInput<A extends AuditAction> = WorkspaceField<A> &
  ReasonField<A> & {
    readonly actor: AuditEvent["actor"];
    readonly targetId: string;
    readonly details: AuditDetails<A>;
  };

export interface AuditContext {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly correlationId: string;
}

/**
 * Builds an audit event for a catalog action. Invalid input is a programmer error and throws;
 * error messages name fields and keys but never echo values.
 */
export function auditEvent<A extends AuditAction>(
  action: A,
  input: AuditEventInput<A>,
  context: AuditContext,
): AuditEvent {
  if (!Object.hasOwn(AUDIT_ACTIONS, action)) throw new Error(`unknown audit action: ${action}`);
  const definition: AuditActionDefinition = AUDIT_ACTIONS[action];
  const { workspaceId, reason } = input as {
    readonly workspaceId?: string | null;
    readonly reason?: string;
  };
  const scope: AuditScope =
    definition.scope === "either"
      ? workspaceId === null
        ? "account"
        : "workspace"
      : definition.scope;

  if (scope === "workspace" && !workspaceId) {
    throw new Error(`${action} is workspace-scoped and needs a workspace ID`);
  }
  if (definition.scope === "account" && workspaceId !== undefined) {
    throw new Error(`${action} is account-scoped and takes no workspace ID`);
  }
  if (input.actor.type !== "system" && !input.actor.id) {
    throw new Error(`audit actor of type ${input.actor.type} needs an ID`);
  }
  if (!input.targetId) throw new Error("audit target ID is required");
  if (definition.requiresReason && !reason?.trim()) {
    throw new Error(`${action} needs a reason`);
  }
  if (!context.correlationId) throw new Error("audit correlation ID is required");

  const parsed = definition.details.safeParse(input.details);
  if (!parsed.success) {
    // Each issue is named by its dotted path, for example `changes.name.to`.
    const fields = parsed.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => [...issue.path, key].join("."))
        : [issue.path.join(".")],
    );
    throw new Error(`invalid details for ${action}: ${fields.join(", ")}`);
  }

  return {
    id: context.ids.next(),
    scope,
    workspaceId: workspaceId ?? null,
    actor: { type: input.actor.type, id: input.actor.id },
    action,
    target: { type: definition.targetType, id: input.targetId },
    reason: reason ?? null,
    correlationId: context.correlationId,
    occurredAt: context.clock.now(),
    details: parsed.data,
  };
}
