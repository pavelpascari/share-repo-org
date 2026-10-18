/**
 * Checks the tenant-key conventions from docs/decisions/0004 against a live schema:
 * - a tenant table is any table with a `workspace_id` column;
 * - `workspace_id` is NOT NULL;
 * - the table has UNIQUE(workspace_id, id), or a composite primary key that starts with
 *   `workspace_id` (e.g. workspace_memberships), so other tenant tables can reference it;
 * - a foreign key to another tenant table includes workspace_id -> workspace_id;
 * - a foreign key to the root `workspaces` table is exactly workspace_id -> id.
 */

export type ConformanceRule = "workspace-id-not-null" | "tenant-key" | "composite-fk" | "root-fk";

export interface ConformanceViolation {
  table: string;
  rule: ConformanceRule;
  detail: string;
}

export interface ConformanceExemption {
  table: string;
  reason: string;
}

interface ColumnInfo {
  name: string;
  notnull: number;
  pk: number;
}

interface IndexListRow {
  name: string;
  unique: number;
  partial: number;
}

interface ForeignKeyRow {
  id: number;
  seq: number;
  table: string;
  from: string;
  to: string | null;
}

const ROOT_TABLE = "workspaces";
const TENANT_COLUMN = "workspace_id";

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

async function pragma<T>(db: D1Database, name: string, arg: string): Promise<T[]> {
  const { results } = await db.prepare(`PRAGMA ${name}(${quote(arg)})`).all<T>();
  return results;
}

async function listTables(db: D1Database): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table'
         AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\'
       ORDER BY name`,
    )
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

const primaryKeyColumns = (columns: ColumnInfo[]) =>
  columns
    .filter((column) => column.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((column) => column.name);

async function hasTenantKey(db: D1Database, table: string, columns: ColumnInfo[]) {
  const pk = primaryKeyColumns(columns);
  if (pk.length >= 2 && pk[0] === TENANT_COLUMN) return true;
  for (const index of await pragma<IndexListRow>(db, "index_list", table)) {
    if (index.unique !== 1 || index.partial === 1) continue;
    const indexColumns = (await pragma<{ name: string }>(db, "index_info", index.name)).map(
      (column) => column.name,
    );
    if (
      indexColumns.length === 2 &&
      indexColumns.includes(TENANT_COLUMN) &&
      indexColumns.includes("id")
    ) {
      return true;
    }
  }
  return false;
}

export async function checkTenantSchema(
  db: D1Database,
  exemptions: readonly ConformanceExemption[] = [],
): Promise<ConformanceViolation[]> {
  const exempt = new Set(exemptions.map((exemption) => exemption.table));
  const columnsByTable = new Map<string, ColumnInfo[]>();
  for (const table of await listTables(db)) {
    columnsByTable.set(table, await pragma<ColumnInfo>(db, "table_info", table));
  }
  const isTenant = (table: string) =>
    columnsByTable.get(table)?.some((column) => column.name === TENANT_COLUMN) ?? false;

  const violations: ConformanceViolation[] = [];
  for (const [table, columns] of columnsByTable) {
    if (!isTenant(table) || exempt.has(table)) continue;

    if (columns.find((column) => column.name === TENANT_COLUMN)?.notnull !== 1) {
      violations.push({ table, rule: "workspace-id-not-null", detail: "workspace_id is nullable" });
    }
    if (!(await hasTenantKey(db, table, columns))) {
      violations.push({
        table,
        rule: "tenant-key",
        detail: "missing UNIQUE(workspace_id, id) or a primary key starting with workspace_id",
      });
    }

    const foreignKeys = new Map<number, ForeignKeyRow[]>();
    for (const row of await pragma<ForeignKeyRow>(db, "foreign_key_list", table)) {
      foreignKeys.set(row.id, [...(foreignKeys.get(row.id) ?? []), row]);
    }
    for (const rows of foreignKeys.values()) {
      const parent = (rows[0] as ForeignKeyRow).table;
      // A NULL target column means "the parent's primary key", in declaration order.
      const parentPk = primaryKeyColumns(columnsByTable.get(parent) ?? []);
      const pairs = rows
        .sort((a, b) => a.seq - b.seq)
        .map((row) => `${row.from}->${row.to ?? parentPk[row.seq]}`);
      const description = `(${pairs.join(", ")}) references ${parent}`;
      if (parent === ROOT_TABLE) {
        if (pairs.length !== 1 || pairs[0] !== `${TENANT_COLUMN}->id`) {
          violations.push({ table, rule: "root-fk", detail: description });
        }
      } else if (isTenant(parent)) {
        if (pairs.length < 2 || !pairs.includes(`${TENANT_COLUMN}->${TENANT_COLUMN}`)) {
          violations.push({ table, rule: "composite-fk", detail: description });
        }
      }
    }
  }
  return violations;
}
