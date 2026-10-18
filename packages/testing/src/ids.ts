import type { IdGenerator } from "@sharerepo/domain";

export interface SequentialIdsOptions {
  /** Prepended to every ID. Defaults to `id-`. */
  prefix?: string;
  /** First number in the sequence. Defaults to 1. */
  start?: number;
}

/** A deterministic `IdGenerator`: `id-000001`, `id-000002`, … */
export class SequentialIds implements IdGenerator {
  readonly #prefix: string;
  #next: number;

  constructor(options: SequentialIdsOptions = {}) {
    const start = options.start ?? 1;
    if (!Number.isSafeInteger(start) || start < 0) {
      throw new RangeError(`start must be a non-negative integer, got ${start}`);
    }
    this.#prefix = options.prefix ?? "id-";
    this.#next = start;
  }

  next(): string {
    const id = `${this.#prefix}${String(this.#next).padStart(6, "0")}`;
    this.#next += 1;
    return id;
  }
}

export interface FreshWorkspaceIds {
  workspaceId: string;
  userId: string;
  slug: string;
}

/**
 * Unique identifiers for one test. D1 storage is isolated per test file, not per test,
 * so tests in the same file must not reuse IDs or slugs.
 */
export function freshWorkspaceIds(): FreshWorkspaceIds {
  return {
    workspaceId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    slug: `test-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`,
  };
}
