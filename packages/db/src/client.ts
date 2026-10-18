import { sql } from "drizzle-orm";
import { type DrizzleD1Database, drizzle } from "drizzle-orm/d1";
import * as schema from "./schema/index.ts";

export type Db = DrizzleD1Database<typeof schema>;

export function createDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

/** Readiness probe: resolves when D1 answers `SELECT 1`, rejects otherwise. */
export async function ping(db: Db): Promise<void> {
  await db.run(sql`SELECT 1`);
}
