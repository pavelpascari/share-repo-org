import type { Instant } from "@sharerepo/domain";
import { type AuditEvents, auditInserts } from "./audit-repository.ts";
import type { Db } from "./client.ts";
import { users } from "./schema/index.ts";

export type User = typeof users.$inferSelect;

/** Creates a user and its audit events in one atomic batch. Constraint errors propagate. */
export async function createUser(
  db: Db,
  input: { id: string; now: Instant },
  audit: AuditEvents,
): Promise<User> {
  const user: User = { id: input.id, createdAt: input.now, updatedAt: input.now, deletedAt: null };
  await db.batch([db.insert(users).values(user), ...auditInserts(db, audit)]);
  return user;
}
