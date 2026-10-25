/**
 * Generic audit completeness check (decision 0007, scenario `audit/every-state-change-has-audit-event`):
 * snapshot every table, run an operation, and require an audit event with the operation's
 * correlation ID whenever any audited table changed.
 */

/** Tables whose changes need no audit event of their own, each with the reason. */
export const UNAUDITED_TABLES: Readonly<Record<string, string>> = {
  audit_events: "the audit log itself",
  d1_migrations: "migration bookkeeping",
  auth_sessions: "Better Auth sessions; sign-in and sign-out are audited as auth.* events",
  auth_verifications: "transient Better Auth OAuth state",
  auth_rate_limits: "Better Auth rate-limit counters",
  claim_rate_limits: "claim request and checkout start rate-limit counters (bookkeeping)",
  external_events: "receipt bookkeeping; the resulting changes are audited",
  outbox: "work hand-off bookkeeping (decision 0003)",
};

export type TableSnapshot = ReadonlyMap<string, string>;

export interface AuditedChange<T> {
  readonly result: T;
  /** Audited tables whose contents changed, sorted. */
  readonly changedTables: readonly string[];
  /** Audit events written with the correlation ID during the operation. */
  readonly auditEventCount: number;
}

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

/** Every user table's contents, as a canonical string per table. */
export async function snapshotTables(
  db: D1Database,
  ignore: Readonly<Record<string, string>> = UNAUDITED_TABLES,
): Promise<TableSnapshot> {
  const { results: tables } = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
    .all<{ name: string }>();
  const snapshot = new Map<string, string>();
  for (const { name } of tables) {
    if (Object.hasOwn(ignore, name)) continue;
    const { results } = await db.prepare(`SELECT * FROM ${quote(name)}`).all();
    snapshot.set(name, JSON.stringify(results.map((row) => JSON.stringify(row)).sort()));
  }
  return snapshot;
}

/** Names of tables that differ between two snapshots, including added or dropped tables. */
export function changedTables(before: TableSnapshot, after: TableSnapshot): string[] {
  const names = new Set([...before.keys(), ...after.keys()]);
  return [...names].filter((name) => before.get(name) !== after.get(name)).sort();
}

async function count(db: D1Database, query: string, ...params: string[]): Promise<number> {
  const [n] = await db
    .prepare(query)
    .bind(...params)
    .raw<[number]>()
    .then((rows) => rows.map(([value]) => value));
  return Number(n);
}

const countAuditEvents = (db: D1Database, correlationId: string) =>
  count(db, "SELECT count(*) FROM audit_events WHERE correlation_id = ?", correlationId);

const countAllAuditEvents = (db: D1Database) => count(db, "SELECT count(*) FROM audit_events");

/**
 * Runs `operation` and fails if it changed an audited table without writing at least one audit
 * event carrying `correlationId`. Returns the operation's result for further assertions.
 */
export async function expectAuditedChange<T>(
  db: D1Database,
  correlationId: string,
  operation: () => Promise<T>,
  ignore: Readonly<Record<string, string>> = UNAUDITED_TABLES,
): Promise<AuditedChange<T>> {
  const before = await snapshotTables(db, ignore);
  const auditBefore = await countAuditEvents(db, correlationId);
  const result = await operation();
  const changed = changedTables(before, await snapshotTables(db, ignore));
  const auditEventCount = (await countAuditEvents(db, correlationId)) - auditBefore;
  if (changed.length > 0 && auditEventCount === 0) {
    throw new Error(
      `State changed in ${changed.join(", ")} without an audit event for correlation ID ${correlationId}`,
    );
  }
  return { result, changedTables: changed, auditEventCount };
}

/**
 * Runs an operation expected to fail and asserts it left no trace: no audited table changed and
 * no audit event was written. Returns the rejection reason.
 */
export async function expectNoChangeOnFailure(
  db: D1Database,
  operation: () => Promise<unknown>,
  ignore: Readonly<Record<string, string>> = UNAUDITED_TABLES,
): Promise<unknown> {
  const before = await snapshotTables(db, ignore);
  const auditBefore = await countAllAuditEvents(db);
  let reason: unknown;
  let failed = false;
  try {
    await operation();
  } catch (error) {
    failed = true;
    reason = error;
  }
  if (!failed) throw new Error("Expected the operation to fail, but it succeeded");
  const changed = changedTables(before, await snapshotTables(db, ignore));
  if (changed.length > 0) throw new Error(`A failed operation changed ${changed.join(", ")}`);
  if ((await countAllAuditEvents(db)) !== auditBefore) {
    throw new Error("A failed operation wrote audit events");
  }
  return reason;
}
