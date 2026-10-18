import { getTableColumns, type SQL, sql } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import type { Db } from "./client.ts";

/** One statement of a D1 batch. */
export type Statement = BatchItem<"sqlite">;

/**
 * Runs statements as one D1 batch, which D1 executes as a single transaction, and returns how
 * many rows each statement changed, in order. The caller guarantees at least one statement.
 */
export async function runBatch(db: Db, statements: readonly Statement[]): Promise<number[]> {
  const results = await db.batch(statements as [Statement, ...Statement[]]);
  return results.map((result) => (result as D1Result).meta.changes);
}

/**
 * `INSERT … SELECT <row> WHERE <condition>`: inserts the full row only if `condition` holds when
 * the statement runs, so a batch can make an insert depend on an earlier guard. Drizzle lists
 * every column in table order for INSERT … SELECT; the values are selected in that order.
 */
export function insertWhere<T extends SQLiteTable>(
  db: Db,
  table: T,
  row: T["$inferSelect"],
  condition: SQL,
) {
  const values = Object.keys(getTableColumns(table)).map(
    (key) => sql`${(row as Record<string, unknown>)[key]}`,
  );
  return db.insert(table).select(sql`SELECT ${sql.join(values, sql`, `)} WHERE ${condition}`);
}
