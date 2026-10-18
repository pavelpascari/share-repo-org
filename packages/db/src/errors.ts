// Classifies D1 constraint failures without exposing the failing statement. Drizzle wraps D1
// errors outside `batch()` (the D1 error is the `cause`) and its message includes the SQL and the
// bound parameters, so callers branch on these helpers instead of reading messages themselves.

const UNIQUE_FAILURE = /UNIQUE constraint failed: ([\w.]+(?:, [\w.]+)*)/;

/** The `table.column` names of a UNIQUE constraint failure anywhere in the cause chain, or null. */
export function uniqueViolationColumns(error: unknown): readonly string[] | null {
  const seen = new Set<unknown>();
  for (let link = error; link instanceof Error && !seen.has(link); link = link.cause) {
    seen.add(link);
    const columns = UNIQUE_FAILURE.exec(link.message)?.[1];
    if (columns !== undefined) return columns.split(", ");
  }
  return null;
}

/** True when the error is a UNIQUE failure on exactly these `table.column` names, in order. */
export function isUniqueViolation(error: unknown, columns: readonly string[]): boolean {
  return uniqueViolationColumns(error)?.join(",") === columns.join(",");
}
