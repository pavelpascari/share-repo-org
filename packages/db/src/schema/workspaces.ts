import {
  type Instant,
  WORKSPACE_NAME_MAX_LENGTH,
  WORKSPACE_ROLES,
  WORKSPACE_SLUG_MAX_LENGTH,
  WORKSPACE_SLUG_MIN_LENGTH,
  WORKSPACE_STATUSES,
  type WorkspaceName,
  type WorkspaceSlug,
} from "@sharerepo/domain";
import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { literalList } from "./sql.ts";
import { users } from "./users.ts";

// SQLite has no regular expressions. GLOB is case-sensitive and expresses the same format:
// only [a-z0-9-], with no leading, trailing, or doubled hyphen.
const slugFormat = sql.raw(
  [
    `length(slug) BETWEEN ${WORKSPACE_SLUG_MIN_LENGTH} AND ${WORKSPACE_SLUG_MAX_LENGTH}`,
    `slug NOT GLOB '*[^a-z0-9-]*'`,
    `slug NOT GLOB '-*'`,
    `slug NOT GLOB '*-'`,
    `slug NOT GLOB '*--*'`,
  ].join(" AND "),
);

// SQLite's trim() strips only the characters listed, so the database rejects surrounding ASCII
// whitespace; the domain trims all Unicode whitespace before writing.
const nameFormat = sql.raw(
  `length(name) BETWEEN 1 AND ${WORKSPACE_NAME_MAX_LENGTH} AND name = trim(name, ' ' || char(9, 10, 11, 12, 13))`,
);

/**
 * The tenant root. Its `id` is the `workspace_id` that every tenant-owned table carries.
 *
 * Deletion (decision 0015): `deleting` and `purging` carry `delete_after`, when the purge may
 * start, and `deletion_requested_by`, the requesting user's ID. That ID has no foreign key, like
 * an audit actor's: the requester may delete their account while the workspace is `deleting`.
 * Hand-written triggers (migration 0009) allow `purging` only after `deleting`, never leave it,
 * and refuse a new workspace that is already being deleted: `purging` unlocks deleting the
 * workspace's audit history.
 */
export const workspaces = sqliteTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    slug: text("slug").$type<WorkspaceSlug>().notNull().unique(),
    name: text("name").$type<WorkspaceName>().notNull(),
    status: text("status", { enum: WORKSPACE_STATUSES }).notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
    updatedAt: integer("updated_at").$type<Instant>().notNull(),
    deleteAfter: integer("delete_after").$type<Instant>(),
    deletionRequestedBy: text("deletion_requested_by"),
  },
  () => [
    check("workspaces_slug_format", slugFormat),
    check("workspaces_name_format", nameFormat),
    check("workspaces_status_valid", sql`status IN (${literalList(WORKSPACE_STATUSES)})`),
    check("workspaces_updated_after_created", sql`updated_at >= created_at`),
    // A deletion is scheduled exactly while the workspace is being deleted, and names who asked.
    check(
      "workspaces_deletion_scheduled",
      sql`(status IN ('deleting', 'purging')) = (delete_after IS NOT NULL)`,
    ),
    check(
      "workspaces_deletion_requester",
      sql`(delete_after IS NULL) = (deletion_requested_by IS NULL) AND (deletion_requested_by IS NULL OR length(deletion_requested_by) > 0)`,
    ),
  ],
);

// ON DELETE RESTRICT: removing a workspace or a user must be an explicit, audited process that
// revokes access first, never a silent cascade through tenant data.
export const workspaceMemberships = sqliteTable(
  "workspace_memberships",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "restrict" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    role: text("role", { enum: WORKSPACE_ROLES }).notNull(),
    createdAt: integer("created_at").$type<Instant>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.userId] }),
    index("workspace_memberships_user_id_idx").on(t.userId),
    check("workspace_memberships_role_valid", sql`role IN (${literalList(WORKSPACE_ROLES)})`),
  ],
);
