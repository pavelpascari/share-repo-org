import {
  AUDIT_ACTOR_TYPES,
  AUDIT_SCOPES,
  type AuditActorType,
  type AuditScope,
  type Instant,
} from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { literalList } from "./sql.ts";
import { workspaces } from "./workspaces.ts";

/**
 * Append-only audit history (decision 0007). UPDATE and DELETE are rejected by triggers that are
 * appended by hand to the migration (Drizzle does not model triggers); a test proves they exist.
 * The one exception (decision 0015, migration 0009): a workspace's purge deletes its events while
 * the workspace is `purging`.
 */
export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    scope: text("scope", { enum: AUDIT_SCOPES }).$type<AuditScope>().notNull(),
    // Set for workspace events, null for account events (enforced by a CHECK below).
    workspaceId: text("workspace_id").references(() => workspaces.id, { onDelete: "restrict" }),
    actorType: text("actor_type", { enum: AUDIT_ACTOR_TYPES }).$type<AuditActorType>().notNull(),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    reason: text("reason"),
    correlationId: text("correlation_id").notNull(),
    occurredAt: integer("occurred_at").$type<Instant>().notNull(),
    // JSON validated against the action's schema in @sharerepo/domain. Never secrets or emails.
    details: text("details").notNull(),
  },
  (t) => [
    index("audit_events_workspace_occurred_idx").on(t.workspaceId, t.occurredAt),
    index("audit_events_correlation_id_idx").on(t.correlationId),
    index("audit_events_target_idx").on(t.targetType, t.targetId),
    check("audit_events_scope_valid", sql`scope IN (${literalList(AUDIT_SCOPES)})`),
    check("audit_events_scope_workspace", sql`(scope = 'workspace') = (workspace_id IS NOT NULL)`),
    check("audit_events_actor_type_valid", sql`actor_type IN (${literalList(AUDIT_ACTOR_TYPES)})`),
    // System actors may be anonymous; people and providers are always identified.
    check("audit_events_actor_id_present", sql`actor_type = 'system' OR actor_id IS NOT NULL`),
    check("audit_events_details_json", sql`json_valid(details) AND json_type(details) = 'object'`),
  ],
);
