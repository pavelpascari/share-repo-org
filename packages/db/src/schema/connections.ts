import {
  CONNECTABLE_ACCOUNT_TYPES,
  CONNECTION_STATUSES,
  type ConnectableAccountType,
  type ConnectionStatus,
  IDENTITY_PROVIDERS,
  type IdentityProvider,
  type Instant,
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
} from "drizzle-orm/sqlite-core";
import { literalList } from "./sql.ts";
import { users } from "./users.ts";
import { workspaceMemberships, workspaces } from "./workspaces.ts";

/**
 * A pending "Connect GitHub" started by a workspace member. Its single-use token (stored hashed)
 * is the `state` GitHub returns to the setup callback, binding the installation to this
 * workspace and user (Phase 2 plan). The composite FK means only a member can hold one.
 */
export const connectionIntents = sqliteTable(
  "connection_intents",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    tokenHash: text("token_hash").notNull().unique(),
    writeAccessAcknowledgedAt: integer("write_access_acknowledged_at").$type<Instant>().notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    expiresAt: integer("expires_at").$type<Instant>().notNull(),
    consumedAt: integer("consumed_at").$type<Instant>(),
  },
  (t) => [
    unique("connection_intents_workspace_id_id_unique").on(t.workspaceId, t.id),
    foreignKey({
      name: "connection_intents_membership_fk",
      columns: [t.workspaceId, t.userId],
      foreignColumns: [workspaceMemberships.workspaceId, workspaceMemberships.userId],
    }).onDelete("restrict"),
    check("connection_intents_expiry_after_creation", sql`expires_at > created_at`),
    check(
      "connection_intents_consumed_in_window",
      sql`consumed_at IS NULL OR consumed_at >= created_at`,
    ),
  ],
);

/** A workspace's GitHub App installation (domain `Connection`). */
export const connections = sqliteTable(
  "connections",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    provider: text("provider", { enum: IDENTITY_PROVIDERS }).$type<IdentityProvider>().notNull(),
    // GitHub installation IDs are global: one installation belongs to at most one workspace.
    installationId: text("installation_id").notNull().unique(),
    accountExternalId: text("account_external_id").notNull(),
    accountLoginSnapshot: text("account_login_snapshot").notNull(),
    accountType: text("account_type", { enum: CONNECTABLE_ACCOUNT_TYPES })
      .$type<ConnectableAccountType>()
      .notNull(),
    status: text("status", { enum: CONNECTION_STATUSES }).$type<ConnectionStatus>().notNull(),
    // Validated JSON object of the installation's granted permissions, as last observed.
    permissions: text("permissions").notNull(),
    writeAccessAcknowledgedAt: integer("write_access_acknowledged_at").$type<Instant>().notNull(),
    createdByUserId: text("created_by_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
    lastSyncedAt: integer("last_synced_at").$type<Instant>(),
    // Optimistic concurrency for resyncs: a resync writes only if the version it read is still
    // current, and marks its write with a unique token so dependent statements can tell.
    syncVersion: integer("sync_version").notNull().default(0),
    syncToken: text("sync_token"),
  },
  (t) => [
    unique("connections_workspace_id_id_unique").on(t.workspaceId, t.id),
    index("connections_workspace_id_idx").on(t.workspaceId),
    check("connections_provider_valid", sql`provider IN (${literalList(IDENTITY_PROVIDERS)})`),
    check(
      "connections_account_type_valid",
      sql`account_type IN (${literalList(CONNECTABLE_ACCOUNT_TYPES)})`,
    ),
    check("connections_status_valid", sql`status IN (${literalList(CONNECTION_STATUSES)})`),
    check(
      "connections_permissions_json",
      sql`json_valid(permissions) AND json_type(permissions) = 'object'`,
    ),
    check("connections_updated_after_created", sql`updated_at >= created_at`),
  ],
);
