// Backup and restore drill for D1 (docs/runbooks/backup-and-restore.md).
//
//   node scripts/db-drill.ts [--persist-to <dir>] [--keep]
//   node scripts/db-drill.ts --remote [--env production] [--keep]
//
// Exports a database with `wrangler d1 export`, restores the export into a fresh local D1 in a
// scratch directory, applies the repository's pending migrations there, and checks the result:
// every exported row, index and trigger is present, the migrations table matches the repository,
// `PRAGMA quick_check` is ok (D1 refuses `integrity_check`) and `PRAGMA foreign_key_check` finds
// nothing. It never writes to the source: a local source is copied first, and a remote one is
// only exported.
//
// A D1 export lists tables in creation order, and a table that a migration rebuilt (0009 rebuilt
// `workspaces`) comes after the tables that reference it. D1 enforces foreign keys, so inserting
// into a child table whose parent table does not exist yet fails ("no such table"), even with
// deferred foreign keys; and a composite foreign key fails ("foreign key mismatch") until its
// parent's unique index exists, which the export creates after the rows. The drill therefore
// writes `restore.sql`: the same statements with every CREATE TABLE and CREATE INDEX moved before
// the first INSERT. That file is what a real restore into a new database imports.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { nodeIo, type ScriptIo } from "./io.ts";

export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** The side effects of the drill, beyond `ScriptIo`, injected so its logic is testable. */
export interface DrillIo extends ScriptIo {
  run(command: string, args: readonly string[], cwd: string): CommandResult;
  makeTempDir(prefix: string): string;
  copyDir(from: string, to: string): void;
  exists(path: string): boolean;
  remove(path: string): void;
}

/** One table's exported rows, and the schema objects the export creates. */
export interface DumpSummary {
  rows: Map<string, number>;
  indexes: string[];
  triggers: string[];
  migrations: string[];
}

const USAGE =
  "Usage: node scripts/db-drill.ts [--persist-to <dir>] [--keep]\n" +
  "       node scripts/db-drill.ts --remote [--env <name>] [--keep]";

const CREATE_TRIGGER = /^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\b/i;
const TRIGGER_END = /\bEND\s*;$/i;

/**
 * Splits SQL into statements at semicolons outside quotes, identifiers and trigger bodies. Each
 * statement keeps its semicolon; whitespace between statements is dropped.
 */
export function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of sql) {
    current += char;
    if (quote !== null) {
      // A doubled quote inside a literal closes and reopens it, which this toggling handles.
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char !== ";") continue;
    const statement = current.trim();
    if (CREATE_TRIGGER.test(statement) && !TRIGGER_END.test(statement)) continue;
    statements.push(statement);
    current = "";
  }
  if (current.trim() !== "") statements.push(current.trim());
  return statements;
}

const isPragma = (statement: string) => /^PRAGMA\b/i.test(statement);
const isCreateTable = (statement: string) => /^CREATE\s+TABLE\b/i.test(statement);
const isCreateIndex = (statement: string) => /^CREATE\s+(?:UNIQUE\s+)?INDEX\b/i.test(statement);

/**
 * The export's statements in an order D1 can import: PRAGMAs, every CREATE TABLE, every CREATE
 * INDEX (a composite foreign key needs its parent's unique index before a child row is
 * inserted), then the rest (rows, then triggers) in their exported order.
 */
export function orderForRestore(sql: string): string {
  const statements = splitStatements(sql);
  const schema = (statement: string) =>
    isPragma(statement) || isCreateTable(statement) || isCreateIndex(statement);
  const ordered = [
    ...statements.filter(isPragma),
    ...statements.filter(isCreateTable),
    ...statements.filter(isCreateIndex),
    ...statements.filter((statement) => !schema(statement)),
  ];
  return `${ordered.join("\n")}\n`;
}

/** An identifier as the export quotes it: "name", `name` or bare. */
const IDENTIFIER = String.raw`(?:"([^"]+)"|\x60([^\x60]+)\x60|([A-Za-z_][\w$]*))`;
const INSERT = new RegExp(String.raw`^INSERT\s+INTO\s+${IDENTIFIER}`, "i");
const CREATE_INDEX = new RegExp(
  String.raw`^CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`,
  "i",
);
const CREATE_TRIGGER_NAME = new RegExp(
  String.raw`^CREATE\s+(?:TEMP\s+|TEMPORARY\s+)?TRIGGER\s+(?:IF\s+NOT\s+EXISTS\s+)?${IDENTIFIER}`,
  "i",
);
const MIGRATION_NAME = /VALUES\s*\(\s*\d+\s*,\s*'((?:[^']|'')*)'/i;

const nameOf = (match: RegExpMatchArray) => match[1] ?? match[2] ?? match[3] ?? "";

/** What the export holds: rows per table, index and trigger names, and applied migrations. */
export function summarizeDump(sql: string): DumpSummary {
  const summary: DumpSummary = { rows: new Map(), indexes: [], triggers: [], migrations: [] };
  for (const statement of splitStatements(sql)) {
    const insert = statement.match(INSERT);
    if (insert !== null) {
      const table = nameOf(insert);
      // SQLite's own bookkeeping, rewritten by the inserts it follows.
      if (table === "sqlite_sequence") continue;
      summary.rows.set(table, (summary.rows.get(table) ?? 0) + 1);
      if (table === "d1_migrations") {
        summary.migrations.push((statement.match(MIGRATION_NAME)?.[1] ?? "").replaceAll("''", "'"));
      }
      continue;
    }
    const index = statement.match(CREATE_INDEX);
    if (index !== null) {
      summary.indexes.push(nameOf(index));
      continue;
    }
    const trigger = statement.match(CREATE_TRIGGER_NAME);
    if (trigger !== null) summary.triggers.push(nameOf(trigger));
  }
  return summary;
}

/** The scratch Wrangler configuration of one local database: the web Worker's D1 binding. */
export function drillConfig(name: string, migrationsDir: string): string {
  return `${JSON.stringify(
    {
      name,
      compatibility_date: "2026-10-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "sharerepo-dev",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: migrationsDir,
        },
      ],
    },
    null,
    2,
  )}\n`;
}

class DrillError extends Error {}

function wrangler(io: DrillIo, root: string, args: readonly string[]): string {
  const result = io.run("pnpm", ["exec", "wrangler", ...args], root);
  if (result.status !== 0) {
    throw new DrillError(
      `wrangler ${args.slice(0, 3).join(" ")} failed (exit ${result.status}):\n${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

/** The rows of one statement run against the restored database. */
function query<T>(io: DrillIo, root: string, config: string, sql: string): T[] {
  const stdout = wrangler(io, root, [
    "d1",
    "execute",
    "DB",
    "--local",
    "-c",
    config,
    "--json",
    "--command",
    sql,
  ]);
  const start = stdout.indexOf("[");
  if (start === -1) throw new DrillError(`no JSON result for: ${sql}`);
  const parsed = JSON.parse(stdout.slice(start)) as { results?: T[] }[];
  return parsed[0]?.results ?? [];
}

const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;

/** Differences between two name lists, as report lines. */
function setDifferences(kind: string, expected: readonly string[], actual: readonly string[]) {
  const have = new Set(actual);
  const want = new Set(expected);
  return [
    ...expected.filter((name) => !have.has(name)).map((name) => `missing ${kind} ${name}`),
    ...actual.filter((name) => !want.has(name)).map((name) => `unexpected ${kind} ${name}`),
  ];
}

interface Options {
  remote: boolean;
  env: string | undefined;
  persistTo: string | undefined;
  keep: boolean;
}

function parse(argv: readonly string[]): Options {
  const { values } = parseArgs({
    args: [...argv],
    strict: true,
    options: {
      remote: { type: "boolean", default: false },
      env: { type: "string" },
      "persist-to": { type: "string" },
      keep: { type: "boolean", default: false },
    },
  });
  if (values.remote && values["persist-to"] !== undefined) {
    throw new DrillError("--persist-to is for a local source; it cannot be used with --remote");
  }
  if (!values.remote && values.env !== undefined) {
    throw new DrillError("--env selects a deployed database; use it with --remote");
  }
  return {
    remote: values.remote,
    env: values.env,
    persistTo: values["persist-to"],
    keep: values.keep,
  };
}

/** Exports the source into `backup`, never writing to it. */
function exportSource(io: DrillIo, root: string, work: string, options: Options, backup: string) {
  if (options.remote) {
    const target = options.env === undefined ? [] : ["--env", options.env];
    io.log(`Exporting the remote database${options.env === undefined ? "" : ` (${options.env})`}…`);
    wrangler(io, root, [
      "d1",
      "export",
      "DB",
      "--remote",
      ...target,
      "-c",
      join(root, "apps/web/wrangler.jsonc"),
      "--output",
      backup,
    ]);
    return;
  }
  const state = resolve(root, options.persistTo ?? "apps/web/.wrangler/state");
  const d1 = join(state, "v3/d1");
  if (!io.exists(d1)) throw new DrillError(`no local D1 database under ${state}`);
  // Wrangler exports a local database only from its default state directory, next to the
  // configuration, so the source is copied into a scratch project first.
  const source = join(work, "source");
  io.copyDir(d1, join(source, ".wrangler/state/v3/d1"));
  const config = join(source, "wrangler.jsonc");
  io.writeText(config, drillConfig("sharerepo-drill-source", join(root, "packages/db/migrations")));
  io.log(`Exporting the local database in ${state} (a copy)…`);
  wrangler(io, root, ["d1", "export", "DB", "--local", "-c", config, "--output", backup]);
}

/** Runs the drill. Returns the exit code: 0 ok, 1 a check failed, 2 usage or a step failed. */
export function run(argv: readonly string[], io: DrillIo): number {
  let options: Options;
  try {
    options = parse(argv);
  } catch (error) {
    io.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
  const root = io.cwd;
  const migrationsDir = join(root, "packages/db/migrations");
  const work = io.makeTempDir("sharerepo-drill-");
  const failures: string[] = [];
  try {
    const backup = join(work, "backup.sql");
    exportSource(io, root, work, options, backup);
    const dump = io.readText(backup);
    const expected = summarizeDump(dump);
    const restoreSql = join(work, "restore.sql");
    io.writeText(restoreSql, orderForRestore(dump));

    const config = join(work, "restore", "wrangler.jsonc");
    io.writeText(config, drillConfig("sharerepo-drill-restore", migrationsDir));
    io.log("Restoring into a fresh local database…");
    wrangler(io, root, [
      "d1",
      "execute",
      "DB",
      "--local",
      "-c",
      config,
      "--file",
      restoreSql,
      "-y",
    ]);

    // Rows: every exported row is back, table by table.
    const tables = query<{ name: string }>(
      io,
      root,
      config,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY name",
    ).map((row) => row.name);
    // One row of scalar subqueries: D1 caps the terms of a compound SELECT.
    const [countRow = {}] =
      tables.length === 0
        ? []
        : query<Record<string, number>>(
            io,
            root,
            config,
            `SELECT ${tables.map((table) => `(SELECT COUNT(*) FROM ${quoted(table)}) AS ${quoted(table)}`).join(", ")}`,
          );
    const counts = new Map(tables.map((table) => [table, countRow[table] ?? 0]));
    for (const [table, rows] of expected.rows) {
      const restored = counts.get(table);
      if (restored !== rows)
        failures.push(`${table}: exported ${rows} rows, restored ${restored ?? "no table"}`);
    }
    const restoredRows = [...counts.values()].reduce((sum, n) => sum + n, 0);

    // Schema objects: the same indexes and triggers.
    const objects = query<{ type: string; name: string }>(
      io,
      root,
      config,
      "SELECT type, name FROM sqlite_master WHERE type IN ('index', 'trigger') AND name NOT LIKE 'sqlite_%'",
    );
    const named = (type: string) =>
      objects.filter((row) => row.type === type).map((row) => row.name);
    failures.push(...setDifferences("index", expected.indexes, named("index")));
    failures.push(...setDifferences("trigger", expected.triggers, named("trigger")));

    // Migrations: the backup's are a prefix of the repository's; the rest apply cleanly.
    const repository = io
      .listDir(migrationsDir)
      .filter((entry) => entry.isFile && entry.name.endsWith(".sql"))
      .map((entry) => entry.name)
      .sort();
    const applied = expected.migrations;
    const prefix = applied.every((name, index) => repository[index] === name);
    if (!prefix) {
      failures.push(
        `the backup's migrations (${applied.join(", ") || "none"}) are not a prefix of the repository's`,
      );
    }
    const pending = prefix ? repository.slice(applied.length) : [];
    if (pending.length > 0) {
      io.log(`Applying ${pending.length} pending migration(s): ${pending.join(", ")}…`);
      wrangler(io, root, ["d1", "migrations", "apply", "DB", "--local", "-c", config]);
    }
    const migrations = query<{ name: string }>(
      io,
      root,
      config,
      "SELECT name FROM d1_migrations ORDER BY id",
    ).map((row) => row.name);
    if (prefix && migrations.join("\n") !== repository.join("\n")) {
      failures.push(`migrations after restore: ${migrations.join(", ") || "none"}`);
    }

    // Integrity: quick_check (D1 refuses integrity_check) and the foreign keys.
    const quick = query<{ quick_check: string }>(io, root, config, "PRAGMA quick_check");
    if (quick.length !== 1 || quick[0]?.quick_check !== "ok") {
      failures.push(
        `quick_check: ${quick.map((row) => row.quick_check).join("; ") || "no result"}`,
      );
    }
    const foreignKeys = query<{ table: string; parent: string }>(
      io,
      root,
      config,
      "PRAGMA foreign_key_check",
    );
    for (const row of foreignKeys)
      failures.push(`foreign key: a ${row.table} row has no ${row.parent}`);

    io.log(
      [
        `Tables: ${tables.length}, rows restored: ${restoredRows} (exported: ${[...expected.rows.values()].reduce((sum, n) => sum + n, 0)})`,
        `Indexes (as restored): ${named("index").length}, triggers: ${named("trigger").length}`,
        `Migrations: ${applied.length} in the backup, ${pending.length} applied by the drill, ${migrations.length} now`,
        `quick_check: ${quick[0]?.quick_check ?? "no result"}, foreign key violations: ${foreignKeys.length}`,
      ].join("\n"),
    );
  } catch (error) {
    io.error(`Drill step failed: ${(error as Error).message}`);
    cleanUp(io, work, options.keep);
    return 2;
  }
  cleanUp(io, work, options.keep);
  if (failures.length > 0) {
    io.error(`Drill FAILED:\n${failures.map((line) => `  - ${line}`).join("\n")}`);
    return 1;
  }
  io.log("Drill passed.");
  return 0;
}

function cleanUp(io: DrillIo, work: string, keep: boolean): void {
  if (keep) {
    io.log(`Kept ${work} (backup.sql, restore.sql and the restored database).`);
    return;
  }
  io.remove(work);
}

export const nodeDrillIo: DrillIo = {
  ...nodeIo,
  writeText(path, text) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  },
  run(command, args, cwd) {
    const result = spawnSync(command, [...args], { cwd, encoding: "utf8" });
    return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  },
  makeTempDir: (prefix) => mkdtempSync(join(tmpdir(), prefix)),
  copyDir: (from, to) => cpSync(from, to, { recursive: true }),
  exists: (path) => existsSync(path),
  remove: (path) => rmSync(path, { recursive: true, force: true }),
};

if (import.meta.main) process.exitCode = run(process.argv.slice(2), nodeDrillIo);
