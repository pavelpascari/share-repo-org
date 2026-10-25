import { applyD1Migrations, reset } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

/**
 * Upgrades from every release. Each migration NNNN has a fixture `fixtures/at-NNNN.sql`: rows
 * valid at that migration, at least one in every table. A test applies 0000..NNNN to an empty
 * database, loads the fixture, applies the rest, and checks that every row survives with every
 * value, that columns added later hold their defaults, and that the database is consistent.
 *
 * The fixture of the latest migration has nothing to upgrade through yet; the next migration's
 * test does that. So a new migration NNNN comes with `at-NNNN.sql` (copy the previous fixture and
 * add rows for whatever NNNN introduces), and the first test below fails until it exists.
 */
const migrations = env.TEST_MIGRATIONS;
const fixtureOf = (migration: string) => `at-${migration.slice(0, 4)}.sql`;

type Row = Record<string, unknown>;
type Column = { name: string; pk: number; dflt_value: string | null };

/** Tables owned by SQLite, D1 or the migration runner rather than by our migrations. */
const isInternal = (table: string) =>
  table === "d1_migrations" || table.startsWith("sqlite_") || table.startsWith("_cf_");

/** A fixture's statements: comment lines dropped, split at each `;` that ends a line. */
const statements = (sql: string) =>
  sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

const columnsOf = async (db: D1Database, table: string) =>
  (await db.prepare(`PRAGMA table_info("${table}")`).all<Column>()).results;

/** Every application table's rows, in primary-key order so rebuilt tables compare equal. */
async function snapshot(db: D1Database): Promise<Map<string, Row[]>> {
  const tables = (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>()
  ).results
    .map((row) => row.name)
    .filter((name) => !isInternal(name));
  const result = new Map<string, Row[]>();
  for (const table of tables) {
    const key = (await columnsOf(db, table))
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => `"${column.name}"`);
    expect(key.length, `${table} has a primary key`).toBeGreaterThan(0);
    const rows = await db.prepare(`SELECT * FROM "${table}" ORDER BY ${key.join(", ")}`).all<Row>();
    result.set(table, rows.results);
  }
  return result;
}

/** The value SQLite gives an existing row for a column added later: its default, or null. */
async function addedColumnValues(db: D1Database, table: string, existing: Row) {
  const values: Row = {};
  for (const column of await columnsOf(db, table)) {
    if (column.name in existing) continue;
    values[column.name] =
      column.dflt_value === null
        ? null
        : (await db.prepare(`SELECT ${column.dflt_value} AS v`).first<{ v: unknown }>())?.v;
  }
  return values;
}

/** A few key columns checked by name, so a broken snapshot comparison cannot pass vacuously. */
const SPOT_CHECKS: { since: string; table: string; where: string; expected: Row }[] = [
  {
    since: "0000",
    table: "workspaces",
    where: "id = 'w2'",
    expected: { slug: "beta-tools", status: "suspended" },
  },
  {
    since: "0001",
    table: "audit_events",
    where: "id = 'ae2'",
    expected: { scope: "account", workspace_id: null },
  },
  {
    since: "0002",
    table: "external_events",
    where: "id = 'e2'",
    expected: { processing_state: "failed", attempts: 3 },
  },
  {
    since: "0003",
    table: "outbox",
    where: "id = 'o3'",
    expected: { last_error_code: "transient", sent_at: null },
  },
  {
    since: "0004",
    table: "grants",
    where: "id = 'g3'",
    expected: { state: "error", retry_class: "rate_limited" },
  },
  {
    since: "0005",
    table: "provider_mutations",
    where: "id = 'pm3'",
    expected: { status: "started", finished_at: null },
  },
  {
    since: "0006",
    table: "paddle_connections",
    where: "id = 'pc2'",
    expected: { status: "disconnected", api_key_envelope: null },
  },
  {
    since: "0011",
    table: "users",
    where: "id = 'u4'",
    expected: { deleted_at: 1760097200000 },
  },
];

describe("migration/upgrade-from-each-release-keeps-data", () => {
  // Storage is isolated per file, not per test: each upgrade starts from an empty database.
  beforeEach(async () => {
    await reset();
  });

  it("migration/upgrade-from-each-release-keeps-data: every migration has a fixture, and every fixture a migration", () => {
    expect(Object.keys(env.UPGRADE_FIXTURES).sort()).toEqual(
      migrations.map((migration) => fixtureOf(migration.name)),
    );
  });

  migrations.forEach((migration, index) => {
    const at = migration.name.slice(0, 4);

    it(`migration/upgrade-from-each-release-keeps-data: from ${at}`, async () => {
      const db = env.UPGRADE_DB;
      await applyD1Migrations(db, migrations.slice(0, index + 1));
      const fixture = env.UPGRADE_FIXTURES[fixtureOf(migration.name)];
      if (fixture === undefined) throw new Error(`missing fixtures/${fixtureOf(migration.name)}`);
      await db.batch(statements(fixture).map((statement) => db.prepare(statement)));

      const before = await snapshot(db);
      for (const [table, rows] of before) {
        expect(rows.length, `${fixtureOf(migration.name)} has rows in ${table}`).toBeGreaterThan(0);
      }

      await applyD1Migrations(db, migrations);

      expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
      // D1 does not authorize `integrity_check`; `quick_check` is the check it allows.
      expect((await db.prepare("PRAGMA quick_check").all()).results).toEqual([
        { quick_check: "ok" },
      ]);

      const after = await snapshot(db);
      for (const [table, rows] of before) {
        const [first] = rows;
        if (first === undefined) continue;
        const added = await addedColumnValues(db, table, first);
        expect(after.get(table), table).toEqual(rows.map((row) => ({ ...row, ...added })));
      }

      for (const check of SPOT_CHECKS.filter((spot) => spot.since <= at)) {
        const columns = Object.keys(check.expected).join(", ");
        const row = await db
          .prepare(`SELECT ${columns} FROM ${check.table} WHERE ${check.where}`)
          .first();
        expect(row, `${check.table} ${check.where}`).toEqual(check.expected);
      }
    });
  });
});
