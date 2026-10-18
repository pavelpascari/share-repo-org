import { type SQL, sql } from "drizzle-orm";

// CHECK constraints mirror the rules in @sharerepo/domain. The values are trusted constants,
// inlined as SQL literals because DDL cannot take bound parameters.
export const literalList = (values: readonly string[]): SQL =>
  sql.raw(values.map((value) => `'${value}'`).join(", "));
