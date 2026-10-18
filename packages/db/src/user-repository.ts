import type { Instant } from "@sharerepo/domain";
import type { Db } from "./client.ts";
import { users } from "./schema/index.ts";

export type User = typeof users.$inferSelect;

export async function createUser(db: Db, input: { id: string; now: Instant }): Promise<User> {
  const user: User = { id: input.id, createdAt: input.now, updatedAt: input.now };
  await db.insert(users).values(user);
  return user;
}
