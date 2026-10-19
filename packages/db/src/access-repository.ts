import type { Instant } from "@sharerepo/domain";
import { and, asc, desc, eq, gte, or, sql } from "drizzle-orm";
import { union } from "drizzle-orm/sqlite-core";
import type { Db } from "./client.ts";
import type { Grant } from "./grant-repository.ts";
import { entitlements, grants, resources, subjects } from "./schema/index.ts";
import type { Entitlement } from "./subscription-repository.ts";

/** A subscriber and repository the access view has a row for, with their display names. */
export interface AccessPair {
  subjectId: string;
  subjectLogin: string;
  resourceId: string;
  resourceName: string;
}

// Named result columns, so the compound select below can order by them.
const pairColumns = () => ({
  subjectId: sql<string>`${subjects.id}`.as("subject_id"),
  subjectLogin: sql<string>`${subjects.loginSnapshot}`.as("subject_login"),
  resourceId: sql<string>`${resources.id}`.as("resource_id"),
  resourceName: sql<string>`${resources.nameSnapshot}`.as("resource_name"),
});

/** What the access view shows, read as one consistent snapshot. */
export interface AccessState {
  /** Each pair with desired or observed access, once, by login then repository name. */
  pairs: AccessPair[];
  /** Live entitlements and those that ended at or after `endedSince`: live first, newest first. */
  entitlements: Entitlement[];
  /** All grants, oldest first. */
  grants: Grant[];
}

/**
 * The workspace's access in one D1 batch, which runs as a single transaction, so every
 * entitlement and grant has its pair. Names sort case-insensitively, then by ID.
 */
export async function readAccessState(
  db: Db,
  workspaceId: string,
  options: { endedSince: Instant },
): Promise<AccessState> {
  const visible = or(
    eq(entitlements.state, "active"),
    gte(entitlements.endedAt, options.endedSince),
  );
  // Both pair queries join on the workspace too, so a pair never names another workspace's rows.
  const desiredPairs = db
    .select(pairColumns())
    .from(entitlements)
    .innerJoin(
      subjects,
      and(eq(subjects.workspaceId, workspaceId), eq(subjects.id, entitlements.subjectId)),
    )
    .innerJoin(
      resources,
      and(eq(resources.workspaceId, workspaceId), eq(resources.id, entitlements.resourceId)),
    )
    .where(and(eq(entitlements.workspaceId, workspaceId), visible));
  const observedPairs = db
    .select(pairColumns())
    .from(grants)
    .innerJoin(
      subjects,
      and(eq(subjects.workspaceId, workspaceId), eq(subjects.id, grants.subjectId)),
    )
    .innerJoin(
      resources,
      and(eq(resources.workspaceId, workspaceId), eq(resources.id, grants.resourceId)),
    )
    .where(eq(grants.workspaceId, workspaceId));
  const [pairs, desired, observed] = await db.batch([
    // A compound select orders by its result columns; COLLATE is the one modifier SQLite allows.
    union(desiredPairs, observedPairs).orderBy(
      sql`${sql.identifier("subject_login")} collate nocase`,
      sql`${sql.identifier("resource_name")} collate nocase`,
      sql`${sql.identifier("subject_id")}`,
      sql`${sql.identifier("resource_id")}`,
    ),
    db
      .select()
      .from(entitlements)
      .where(and(eq(entitlements.workspaceId, workspaceId), visible))
      .orderBy(
        sql`${entitlements.state} <> 'active'`,
        desc(entitlements.createdAt),
        asc(entitlements.id),
      ),
    db
      .select()
      .from(grants)
      .where(eq(grants.workspaceId, workspaceId))
      .orderBy(asc(grants.createdAt), asc(grants.id)),
  ]);
  return { pairs, entitlements: desired, grants: observed };
}
