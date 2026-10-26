/**
 * Crash injection for D1 (Phase 6 fault injection): a wrapper around a D1 binding that makes the
 * Nth write fail as a Worker crash would, either `before` it runs (nothing commits) or `after` it
 * committed (the caller never learns it did). A write is one `batch()` call, which D1 runs as one
 * transaction, or one single statement that changes data (INSERT, UPDATE, DELETE, REPLACE).
 * Reads are never counted and never fail.
 *
 * Run an operation once over `crashingD1(binding, null)` to count its writes (`writes`), then
 * once per write boundary with `{ at: n, when }` and re-run it over the plain binding, as the
 * queue or the user would, to check that it converges.
 */

export type CrashWhen = "before" | "after";

export interface CrashPlan {
  /** The 1-based write that fails. */
  readonly at: number;
  readonly when: CrashWhen;
}

export interface CrashingD1 {
  /** The wrapped binding, to build the operation's database from. */
  readonly binding: D1Database;
  /** Writes started so far, the failed one included. */
  readonly writes: number;
  /** Whether the planned crash happened. */
  readonly crashed: boolean;
}

/** The error a planned crash throws; tests match its message. */
export class InjectedCrash extends Error {
  constructor(at: number, when: CrashWhen) {
    super(`injected crash ${when} write ${at}`);
    this.name = "InjectedCrash";
  }
}

const WRITE = /^\s*(?:insert|update|delete|replace)\b/i;
/** A statement that changes data, as far as its leading keyword (after any CTE) says. */
const isWrite = (sql: string) =>
  WRITE.test(sql.replace(/^\s*with\b[\s\S]*?\)\s*(?=insert|update|delete|replace)/i, ""));

const STATEMENT_RUNS = new Set(["run", "all", "raw", "first"]);

/**
 * Wraps `d1` so that the write `plan` names fails (or none, with `null`). Statements are proxied
 * so that single statements can be counted; `batch()` unwraps them before handing them to D1.
 */
export function crashingD1(d1: D1Database, plan: CrashPlan | null): CrashingD1 {
  let writes = 0;
  let crashed = false;
  const real = new WeakMap<object, D1PreparedStatement>();

  /** Runs one write through the plan: counts it, and fails it before or after `execute`. */
  async function write<T>(execute: () => Promise<T>): Promise<T> {
    writes += 1;
    if (plan === null || writes !== plan.at) return execute();
    crashed = true;
    if (plan.when === "after") await execute();
    throw new InjectedCrash(plan.at, plan.when);
  }

  function wrapStatement(statement: D1PreparedStatement, sql: string): D1PreparedStatement {
    const proxy = new Proxy(statement, {
      get(target, property) {
        if (property === "bind") {
          return (...values: unknown[]) => wrapStatement(target.bind(...values), sql);
        }
        const value = Reflect.get(target, property, target) as unknown;
        if (typeof value !== "function") return value;
        if (typeof property === "string" && STATEMENT_RUNS.has(property) && isWrite(sql)) {
          return (...args: unknown[]) =>
            write(() => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
        }
        return (value as (...a: unknown[]) => unknown).bind(target);
      },
    });
    real.set(proxy, statement);
    return proxy;
  }

  const binding = new Proxy(d1, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => wrapStatement(target.prepare(sql), sql);
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) =>
          write(() =>
            target.batch(statements.map((statement) => real.get(statement) ?? statement)),
          );
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });

  return {
    binding,
    get writes() {
      return writes;
    },
    get crashed() {
      return crashed;
    },
  };
}
