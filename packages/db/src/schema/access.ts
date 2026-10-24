import {
  ACCESS_LEVELS,
  type AccessLevel,
  ENTITLEMENT_SOURCE_TYPES,
  ENTITLEMENT_STATES,
  type EntitlementSourceType,
  type EntitlementState,
  GRANT_STATES,
  type GrantState,
  type Instant,
  MUTATION_OPERATIONS,
  MUTATION_STATUSES,
  type MutationOperation,
  type MutationStatus,
  RETRY_CLASSES,
  type RetryClass,
} from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { offerVersions, subjects, subscriptions } from "./commerce.ts";
import { connections } from "./connections.ts";
import { resources } from "./resources.ts";
import { literalList } from "./sql.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Desired access (domain `Entitlement`): a subject should have an access level to a resource for
 * an interval, decided by a policy version from a source. Only `active` rows are live; at most
 * one live row exists per source, offer, resource and subject. A reactivation adds a new row.
 */
export const entitlements = sqliteTable(
  "entitlements",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    subjectId: text("subject_id").notNull(),
    resourceId: text("resource_id").notNull(),
    accessLevel: text("access_level", { enum: ACCESS_LEVELS }).$type<AccessLevel>().notNull(),
    sourceType: text("source_type", { enum: ENTITLEMENT_SOURCE_TYPES })
      .$type<EntitlementSourceType>()
      .notNull(),
    // v1: the subscription the entitlement derives from.
    sourceId: text("source_id").notNull(),
    offerId: text("offer_id").notNull(),
    offerVersion: integer("offer_version").notNull(),
    policyVersion: integer("policy_version").notNull(),
    state: text("state", { enum: ENTITLEMENT_STATES }).$type<EntitlementState>().notNull(),
    validFrom: integer("valid_from").$type<Instant>().notNull(),
    // Null while open-ended; set when policy knows when access ends.
    validUntil: integer("valid_until").$type<Instant>(),
    decisionReason: text("decision_reason").notNull(),
    endedAt: integer("ended_at").$type<Instant>(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("entitlements_workspace_id_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("entitlements_live_unique")
      .on(t.workspaceId, t.sourceId, t.offerId, t.resourceId, t.subjectId)
      .where(sql`state = 'active'`),
    index("entitlements_subject_resource_idx").on(t.workspaceId, t.subjectId, t.resourceId),
    foreignKey({
      name: "entitlements_subject_fk",
      columns: [t.workspaceId, t.subjectId],
      foreignColumns: [subjects.workspaceId, subjects.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "entitlements_resource_fk",
      columns: [t.workspaceId, t.resourceId],
      foreignColumns: [resources.workspaceId, resources.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "entitlements_subscription_fk",
      columns: [t.workspaceId, t.sourceId],
      foreignColumns: [subscriptions.workspaceId, subscriptions.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "entitlements_offer_version_fk",
      columns: [t.workspaceId, t.offerId, t.offerVersion],
      foreignColumns: [offerVersions.workspaceId, offerVersions.offerId, offerVersions.version],
    }).onDelete("restrict"),
    check("entitlements_access_level_valid", sql`access_level IN (${literalList(ACCESS_LEVELS)})`),
    check(
      "entitlements_source_type_valid",
      sql`source_type IN (${literalList(ENTITLEMENT_SOURCE_TYPES)})`,
    ),
    check("entitlements_state_valid", sql`state IN (${literalList(ENTITLEMENT_STATES)})`),
    check("entitlements_policy_version_positive", sql`policy_version >= 1`),
    check("entitlements_interval_valid", sql`valid_until IS NULL OR valid_until > valid_from`),
    check("entitlements_ended_iff_not_active", sql`(state = 'active') = (ended_at IS NULL)`),
    check("entitlements_reason_present", sql`length(decision_reason) > 0`),
    check("entitlements_updated_after_created", sql`updated_at >= created_at`),
  ],
);

/**
 * Observed provider access (domain `Grant`). `managed` is true only for access ShareRepo created;
 * unmanaged access is never revoked. A grant never creates or changes an entitlement.
 */
export const grants = sqliteTable(
  "grants",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").notNull(),
    subjectId: text("subject_id").notNull(),
    resourceId: text("resource_id").notNull(),
    accessLevel: text("access_level", { enum: ACCESS_LEVELS }).$type<AccessLevel>().notNull(),
    state: text("state", { enum: GRANT_STATES }).$type<GrantState>().notNull(),
    managed: integer("managed", { mode: "boolean" }).notNull(),
    // Access that does not come from a direct grant (on a personal repository, the owner's own).
    // Reported and never changed (decision 0010).
    indirect: integer("indirect", { mode: "boolean" }).notNull().default(false),
    entitlementId: text("entitlement_id"),
    // The provider invitation's ID while one is pending.
    externalGrantId: text("external_grant_id"),
    // When the provider invitation lapses, for pending invitations.
    expiresAt: integer("expires_at").$type<Instant>(),
    observedAt: integer("observed_at").$type<Instant>(),
    lastAttemptAt: integer("last_attempt_at").$type<Instant>(),
    lastErrorCode: text("last_error_code"),
    retryClass: text("retry_class", { enum: RETRY_CLASSES }).$type<RetryClass>(),
    // When an errored grant may be retried; null when it waits for a person ("Retry").
    nextAttemptAt: integer("next_attempt_at").$type<Instant>(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("grants_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("grants_identity_unique").on(
      t.workspaceId,
      t.connectionId,
      t.resourceId,
      t.subjectId,
      t.accessLevel,
    ),
    foreignKey({
      name: "grants_connection_fk",
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "grants_subject_fk",
      columns: [t.workspaceId, t.subjectId],
      foreignColumns: [subjects.workspaceId, subjects.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "grants_resource_fk",
      columns: [t.workspaceId, t.resourceId],
      foreignColumns: [resources.workspaceId, resources.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "grants_entitlement_fk",
      columns: [t.workspaceId, t.entitlementId],
      foreignColumns: [entitlements.workspaceId, entitlements.id],
    }).onDelete("restrict"),
    check("grants_access_level_valid", sql`access_level IN (${literalList(ACCESS_LEVELS)})`),
    check("grants_state_valid", sql`state IN (${literalList(GRANT_STATES)})`),
    check(
      "grants_retry_class_valid",
      sql`retry_class IS NULL OR retry_class IN (${literalList(RETRY_CLASSES)})`,
    ),
    check(
      "grants_error_classified",
      sql`(state = 'error') = (last_error_code IS NOT NULL AND retry_class IS NOT NULL)`,
    ),
    check("grants_updated_after_created", sql`updated_at >= created_at`),
  ],
);

/**
 * A change ShareRepo asked an access provider to make (decision 0010; integrations.md
 * § Reconciliation ownership). Written as `started` before the request is sent, then settled once.
 * Rows are never deleted, and only `status`, `error_code`, `retry_class`, `external_id` and
 * `finished_at` change, once, from `started` (enforced by triggers in migration 0005).
 */
export const providerMutations = sqliteTable(
  "provider_mutations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").notNull(),
    grantId: text("grant_id").notNull(),
    subjectId: text("subject_id").notNull(),
    resourceId: text("resource_id").notNull(),
    operation: text("operation", { enum: MUTATION_OPERATIONS })
      .$type<MutationOperation>()
      .notNull(),
    accessLevel: text("access_level", { enum: ACCESS_LEVELS }).$type<AccessLevel>().notNull(),
    status: text("status", { enum: MUTATION_STATUSES }).$type<MutationStatus>().notNull(),
    errorCode: text("error_code"),
    retryClass: text("retry_class", { enum: RETRY_CLASSES }).$type<RetryClass>(),
    // The provider's ID for what the mutation created or removed, such as an invitation ID.
    externalId: text("external_id"),
    // JSON array of the entitlement IDs behind the decision.
    entitlementIds: text("entitlement_ids").notNull(),
    correlationId: text("correlation_id").notNull(),
    startedAt: integer("started_at").$type<Instant>().notNull(),
    finishedAt: integer("finished_at").$type<Instant>(),
  },
  (t) => [
    unique("provider_mutations_workspace_id_id_unique").on(t.workspaceId, t.id),
    index("provider_mutations_budget_idx").on(
      t.workspaceId,
      t.resourceId,
      t.operation,
      t.startedAt,
    ),
    foreignKey({
      name: "provider_mutations_connection_fk",
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "provider_mutations_grant_fk",
      columns: [t.workspaceId, t.grantId],
      foreignColumns: [grants.workspaceId, grants.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "provider_mutations_subject_fk",
      columns: [t.workspaceId, t.subjectId],
      foreignColumns: [subjects.workspaceId, subjects.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "provider_mutations_resource_fk",
      columns: [t.workspaceId, t.resourceId],
      foreignColumns: [resources.workspaceId, resources.id],
    }).onDelete("restrict"),
    check(
      "provider_mutations_operation_valid",
      sql`operation IN (${literalList(MUTATION_OPERATIONS)})`,
    ),
    check(
      "provider_mutations_access_level_valid",
      sql`access_level IN (${literalList(ACCESS_LEVELS)})`,
    ),
    check("provider_mutations_status_valid", sql`status IN (${literalList(MUTATION_STATUSES)})`),
    check(
      "provider_mutations_retry_class_valid",
      sql`retry_class IS NULL OR retry_class IN (${literalList(RETRY_CLASSES)})`,
    ),
    check(
      "provider_mutations_failure_classified",
      sql`(status = 'failed') = (error_code IS NOT NULL AND retry_class IS NOT NULL)`,
    ),
    check(
      "provider_mutations_finished",
      sql`(status = 'started') = (finished_at IS NULL) AND (finished_at IS NULL OR finished_at >= started_at)`,
    ),
    check(
      "provider_mutations_entitlement_ids_json",
      sql`json_valid(entitlement_ids) AND json_type(entitlement_ids) = 'array'`,
    ),
  ],
);
