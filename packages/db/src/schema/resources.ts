import {
  IDENTITY_PROVIDERS,
  type IdentityProvider,
  type Instant,
  RESOURCE_SELECTIONS,
  RESOURCE_TYPES,
  type ResourceSelection,
  type ResourceType,
} from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, foreignKey, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { connections } from "./connections.ts";
import { literalList } from "./sql.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Something a connection can grant access to (domain `Resource`); v1: GitHub repositories. Keyed
 * by the provider's immutable ID within its connection; names are snapshots.
 */
export const resources = sqliteTable(
  "resources",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    connectionId: text("connection_id").notNull(),
    provider: text("provider", { enum: IDENTITY_PROVIDERS }).$type<IdentityProvider>().notNull(),
    type: text("type", { enum: RESOURCE_TYPES }).$type<ResourceType>().notNull(),
    externalId: text("external_id").notNull(),
    nameSnapshot: text("name_snapshot").notNull(),
    ownerExternalId: text("owner_external_id").notNull(),
    private: integer("private", { mode: "boolean" }).notNull(),
    archived: integer("archived", { mode: "boolean" }).notNull(),
    selection: text("selection", { enum: RESOURCE_SELECTIONS })
      .$type<ResourceSelection>()
      .notNull(),
    // Validated JSON object of provider capabilities for this resource (decision 0008).
    capabilities: text("capabilities").notNull(),
    discoveredAt: integer("discovered_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
  },
  (t) => [
    unique("resources_workspace_id_id_unique").on(t.workspaceId, t.id),
    unique("resources_connection_external_unique").on(t.connectionId, t.externalId),
    foreignKey({
      name: "resources_connection_fk",
      columns: [t.workspaceId, t.connectionId],
      foreignColumns: [connections.workspaceId, connections.id],
    }).onDelete("restrict"),
    check("resources_provider_valid", sql`provider IN (${literalList(IDENTITY_PROVIDERS)})`),
    check("resources_type_valid", sql`type IN (${literalList(RESOURCE_TYPES)})`),
    check("resources_selection_valid", sql`selection IN (${literalList(RESOURCE_SELECTIONS)})`),
    check(
      "resources_capabilities_json",
      sql`json_valid(capabilities) AND json_type(capabilities) = 'object'`,
    ),
    check("resources_updated_after_discovered", sql`updated_at >= discovered_at`),
  ],
);
