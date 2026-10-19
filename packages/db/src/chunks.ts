// D1 binds at most 100 parameters per statement. A list bound with `inArray` costs one parameter
// per value, so lists of caller-supplied or workspace-sized length are split into chunks that
// leave room for the statement's other parameters.

/** The most list values one statement binds. */
export const MAX_LIST_PARAMETERS = 90;

/** Splits `values` into consecutive chunks of at most `size` values. */
export function chunked<T>(values: readonly T[], size = MAX_LIST_PARAMETERS): T[][] {
  const chunks: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    chunks.push(values.slice(start, start + size));
  }
  return chunks;
}

/**
 * Runs `select` once per chunk of at most {@link MAX_LIST_PARAMETERS} values and concatenates the
 * results in chunk order. Each chunk is a separate statement, so the caller merges any ordering.
 */
export async function selectInChunks<V, R>(
  values: readonly V[],
  select: (chunk: V[]) => Promise<R[]>,
): Promise<R[]> {
  return (await Promise.all(chunked(values).map(select))).flat();
}

/** Ascending order of two texts, for merging chunked results; ties compare equal. */
export function ascending(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}
