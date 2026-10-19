import {
  ACCESS_LEVELS,
  type AccessLevel,
  COMMERCIAL_SOURCES,
  type CommercialSource,
  GRACE_PERIOD_DAYS_DEFAULT,
  GRACE_PERIOD_DAYS_MAX,
  GRACE_PERIOD_DAYS_MIN,
  IDENTITY_PROVIDERS,
  type IdentityProvider,
  type Instant,
  OFFER_STATUSES,
  type OfferStatus,
  SUBJECT_TYPES,
  SUBSCRIPTION_STATES,
  type SubjectType,
  type SubscriptionState,
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
import { externalIdentities } from "./identities.ts";
import { resources } from "./resources.ts";
import { literalList } from "./sql.ts";
import { users } from "./users.ts";
import { workspaces } from "./workspaces.ts";

const workspaceId = () =>
  text("workspace_id")
    .notNull()
    .references(() => workspaces.id, { onDelete: "restrict" });

/**
 * A creator's promise: commercial items that grant access to resources (domain `Offer`).
 * `version` counts configuration changes; each version has an immutable `offer_versions` row.
 */
export const offers = sqliteTable(
  "offers",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    name: text("name").notNull(),
    status: text("status", { enum: OFFER_STATUSES }).$type<OfferStatus>().notNull(),
    gracePeriodDays: integer("grace_period_days").notNull().default(GRACE_PERIOD_DAYS_DEFAULT),
    version: integer("version").notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("offers_workspace_id_id_unique").on(t.workspaceId, t.id),
    check("offers_name_present", sql`length(trim(name)) > 0`),
    check("offers_status_valid", sql`status IN (${literalList(OFFER_STATUSES)})`),
    check(
      "offers_grace_period_bounds",
      sql.raw(`grace_period_days BETWEEN ${GRACE_PERIOD_DAYS_MIN} AND ${GRACE_PERIOD_DAYS_MAX}`),
    ),
    check("offers_version_positive", sql`version >= 1`),
    check("offers_updated_after_created", sql`updated_at >= created_at`),
  ],
);

/**
 * Immutable snapshot of an offer's configuration at one version, so every entitlement can be
 * explained by what was promised when it was decided (decision 0009). Append-only via triggers.
 */
export const offerVersions = sqliteTable(
  "offer_versions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    offerId: text("offer_id").notNull(),
    version: integer("version").notNull(),
    // Validated JSON: name, grace period, items and accesses at this version.
    snapshot: text("snapshot").notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
  },
  (t) => [
    unique("offer_versions_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("offer_versions_offer_version_unique").on(t.workspaceId, t.offerId, t.version),
    foreignKey({
      name: "offer_versions_offer_fk",
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offers.workspaceId, offers.id],
    }).onDelete("restrict"),
    check("offer_versions_version_positive", sql`version >= 1`),
    check(
      "offer_versions_snapshot_json",
      sql`json_valid(snapshot) AND json_type(snapshot) = 'object'`,
    ),
  ],
);

/** A commercial item (e.g. a price) that an offer sells. One item maps to at most one offer. */
export const offerItems = sqliteTable(
  "offer_items",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    offerId: text("offer_id").notNull(),
    source: text("source", { enum: COMMERCIAL_SOURCES }).$type<CommercialSource>().notNull(),
    externalItemId: text("external_item_id").notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("offer_items_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("offer_items_item_unique").on(t.workspaceId, t.source, t.externalItemId),
    foreignKey({
      name: "offer_items_offer_fk",
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offers.workspaceId, offers.id],
    }).onDelete("restrict"),
    check("offer_items_source_valid", sql`source IN (${literalList(COMMERCIAL_SOURCES)})`),
    check("offer_items_external_item_id_present", sql`length(external_item_id) > 0`),
  ],
);

/** Access an offer promises to one resource. */
export const offerAccesses = sqliteTable(
  "offer_accesses",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    offerId: text("offer_id").notNull(),
    resourceId: text("resource_id").notNull(),
    accessLevel: text("access_level", { enum: ACCESS_LEVELS }).$type<AccessLevel>().notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("offer_accesses_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("offer_accesses_offer_resource_unique").on(t.workspaceId, t.offerId, t.resourceId),
    foreignKey({
      name: "offer_accesses_offer_fk",
      columns: [t.workspaceId, t.offerId],
      foreignColumns: [offers.workspaceId, offers.id],
    }).onDelete("restrict"),
    foreignKey({
      name: "offer_accesses_resource_fk",
      columns: [t.workspaceId, t.resourceId],
      foreignColumns: [resources.workspaceId, resources.id],
    }).onDelete("restrict"),
    check(
      "offer_accesses_access_level_valid",
      sql`access_level IN (${literalList(ACCESS_LEVELS)})`,
    ),
  ],
);

/**
 * An access-provider principal that can receive a grant (domain `Subject`); v1: a GitHub user,
 * keyed by immutable user ID. The login is a snapshot.
 */
export const subjects = sqliteTable(
  "subjects",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    provider: text("provider", { enum: IDENTITY_PROVIDERS }).$type<IdentityProvider>().notNull(),
    type: text("type", { enum: SUBJECT_TYPES }).$type<SubjectType>().notNull(),
    externalSubjectId: text("external_subject_id").notNull(),
    loginSnapshot: text("login_snapshot").notNull(),
    // Set when the principal is a ShareRepo user's linked identity.
    externalIdentityId: text("external_identity_id").references(() => externalIdentities.id, {
      onDelete: "restrict",
    }),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("subjects_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("subjects_external_unique").on(t.workspaceId, t.provider, t.externalSubjectId),
    check("subjects_provider_valid", sql`provider IN (${literalList(IDENTITY_PROVIDERS)})`),
    check("subjects_type_valid", sql`type IN (${literalList(SUBJECT_TYPES)})`),
    check("subjects_external_id_present", sql`length(external_subject_id) > 0`),
    check("subjects_login_present", sql`length(login_snapshot) > 0`),
    check("subjects_updated_after_created", sql`updated_at >= created_at`),
  ],
);

/**
 * A commercial identity within a source (domain `Customer`). Not a ShareRepo user: `subject_id`
 * is set only by an explicit link (decision 0009), never by an email match.
 */
export const customers = sqliteTable(
  "customers",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    source: text("source", { enum: COMMERCIAL_SOURCES }).$type<CommercialSource>().notNull(),
    externalCustomerId: text("external_customer_id").notNull(),
    subjectId: text("subject_id"),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("customers_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("customers_external_unique").on(t.workspaceId, t.source, t.externalCustomerId),
    foreignKey({
      name: "customers_subject_fk",
      columns: [t.workspaceId, t.subjectId],
      foreignColumns: [subjects.workspaceId, subjects.id],
    }).onDelete("restrict"),
    check("customers_source_valid", sql`source IN (${literalList(COMMERCIAL_SOURCES)})`),
    check("customers_external_id_present", sql`length(external_customer_id) > 0`),
    check("customers_updated_after_created", sql`updated_at >= created_at`),
  ],
);

/**
 * Normalized commercial facts observed from a source (domain `Subscription`). Not access.
 * `source_updated_at` orders snapshots: an older or equal one is never applied, so out-of-order
 * processing cannot regress state. `version` gives writers optimistic concurrency.
 */
export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    source: text("source", { enum: COMMERCIAL_SOURCES }).$type<CommercialSource>().notNull(),
    externalSubscriptionId: text("external_subscription_id").notNull(),
    customerId: text("customer_id").notNull(),
    state: text("state", { enum: SUBSCRIPTION_STATES }).$type<SubscriptionState>().notNull(),
    providerState: text("provider_state").notNull(),
    currentPeriodStart: integer("current_period_start").$type<Instant>(),
    currentPeriodEnd: integer("current_period_end").$type<Instant>(),
    // Scheduled effective cancellation of a still-running subscription.
    cancelAt: integer("cancel_at").$type<Instant>(),
    // Effective end of a canceled or expired subscription.
    endedAt: integer("ended_at").$type<Instant>(),
    pastDueSince: integer("past_due_since").$type<Instant>(),
    sourceUpdatedAt: integer("source_updated_at").$type<Instant>().notNull(),
    lastObservedAt: integer("last_observed_at").$type<Instant>().notNull(),
    // When policy must be evaluated again (a grace or cancellation boundary), or null.
    nextEvaluationAt: integer("next_evaluation_at").$type<Instant>(),
    version: integer("version").notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("subscriptions_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("subscriptions_external_unique").on(t.workspaceId, t.source, t.externalSubscriptionId),
    foreignKey({
      name: "subscriptions_customer_fk",
      columns: [t.workspaceId, t.customerId],
      foreignColumns: [customers.workspaceId, customers.id],
    }).onDelete("restrict"),
    index("subscriptions_next_evaluation_idx").on(t.nextEvaluationAt),
    check("subscriptions_source_valid", sql`source IN (${literalList(COMMERCIAL_SOURCES)})`),
    check("subscriptions_state_valid", sql`state IN (${literalList(SUBSCRIPTION_STATES)})`),
    check(
      "subscriptions_period_valid",
      sql`current_period_start IS NULL OR current_period_end IS NULL OR current_period_end > current_period_start`,
    ),
    check(
      "subscriptions_past_due_since_iff_past_due",
      sql`(state = 'past_due') = (past_due_since IS NOT NULL)`,
    ),
    check(
      "subscriptions_ended_at_iff_ended",
      sql`(state IN ('canceled', 'expired')) = (ended_at IS NOT NULL)`,
    ),
    check("subscriptions_version_positive", sql`version >= 1`),
    check("subscriptions_updated_after_created", sql`updated_at >= created_at`),
  ],
);

/** The commercial items a subscription currently carries. */
export const subscriptionItems = sqliteTable(
  "subscription_items",
  {
    id: text("id").primaryKey(),
    workspaceId: workspaceId(),
    subscriptionId: text("subscription_id").notNull(),
    externalItemId: text("external_item_id").notNull(),
  },
  (t) => [
    unique("subscription_items_workspace_id_id_unique").on(t.workspaceId, t.id),
    uniqueIndex("subscription_items_item_unique").on(
      t.workspaceId,
      t.subscriptionId,
      t.externalItemId,
    ),
    foreignKey({
      name: "subscription_items_subscription_fk",
      columns: [t.workspaceId, t.subscriptionId],
      foreignColumns: [subscriptions.workspaceId, subscriptions.id],
    }).onDelete("restrict"),
    check("subscription_items_external_item_id_present", sql`length(external_item_id) > 0`),
  ],
);
