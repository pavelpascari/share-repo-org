import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommandResult,
  type DrillIo,
  drillConfig,
  nodeDrillIo,
  orderForRestore,
  run,
  splitStatements,
  summarizeDump,
} from "../db-drill.ts";
import { memoryIo } from "./memory-io.ts";

const DUMP = `PRAGMA defer_foreign_keys=TRUE;
CREATE TABLE IF NOT EXISTS "d1_migrations"(
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		name TEXT UNIQUE
);
INSERT INTO "d1_migrations" ("id","name") VALUES(1,'0000_init.sql');
INSERT INTO "d1_migrations" ("id","name") VALUES(2,'0001_it''s.sql');
CREATE TABLE \`child\` (\`id\` text, \`parent_id\` text REFERENCES parent(id));
INSERT INTO "child" ("id","parent_id") VALUES('c1;x','p1');
INSERT INTO "child" ("id","parent_id") VALUES('c2 "quoted"','p1');
INSERT INTO "sqlite_sequence" VALUES('d1_migrations',2);
CREATE TABLE IF NOT EXISTS "parent" ("id" text PRIMARY KEY);
INSERT INTO "parent" ("id") VALUES('p1');
CREATE INDEX \`child_parent_idx\` ON \`child\` (\`parent_id\`);
CREATE UNIQUE INDEX IF NOT EXISTS "parent_id_idx" ON "parent" ("id");
CREATE TRIGGER \`parent_no_delete\` BEFORE DELETE ON \`parent\`
BEGIN SELECT RAISE(ABORT, 'parent: no; never'); END;
CREATE TEMP TRIGGER bare_trigger AFTER INSERT ON child BEGIN SELECT 1; END;`;

describe("splitStatements", () => {
  it("splits at semicolons outside literals, identifiers and trigger bodies", () => {
    expect(
      splitStatements(
        "SELECT 'a;b';\n  SELECT \"x;y\"; SELECT `p;q`;CREATE TRIGGER t BEGIN SELECT 1; SELECT 'it''s'; END;\nSELECT 2",
      ),
    ).toEqual([
      "SELECT 'a;b';",
      'SELECT "x;y";',
      "SELECT `p;q`;",
      "CREATE TRIGGER t BEGIN SELECT 1; SELECT 'it''s'; END;",
      "SELECT 2",
    ]);
  });

  it("returns nothing for blank input", () => {
    expect(splitStatements("  \n ")).toEqual([]);
  });
});

describe("orderForRestore", () => {
  it("puts PRAGMAs, then tables, then indexes before the rows and triggers", () => {
    const ordered = orderForRestore(DUMP).trimEnd().split("\n");
    const kinds = splitStatements(orderForRestore(DUMP)).map(
      (statement) => statement.match(/^(PRAGMA|CREATE (?:UNIQUE )?\w+|INSERT)/)?.[1],
    );
    expect(kinds).toEqual([
      "PRAGMA",
      "CREATE TABLE",
      "CREATE TABLE",
      "CREATE TABLE",
      "CREATE INDEX",
      "CREATE UNIQUE INDEX",
      "INSERT",
      "INSERT",
      "INSERT",
      "INSERT",
      "INSERT",
      "INSERT",
      "CREATE TRIGGER",
      "CREATE TEMP",
    ]);
    expect(ordered[0]).toBe("PRAGMA defer_foreign_keys=TRUE;");
  });
});

describe("summarizeDump", () => {
  it("counts rows per table, names indexes, triggers and applied migrations", () => {
    const summary = summarizeDump(DUMP);
    expect(Object.fromEntries(summary.rows)).toEqual({ d1_migrations: 2, child: 2, parent: 1 });
    expect(summary.migrations).toEqual(["0000_init.sql", "0001_it's.sql"]);
    expect(summary.indexes).toEqual(["child_parent_idx", "parent_id_idx"]);
    expect(summary.triggers).toEqual(["parent_no_delete", "bare_trigger"]);
  });

  it("records a migration row it cannot read as an empty name", () => {
    expect(summarizeDump(`INSERT INTO d1_migrations VALUES('odd');`).migrations).toEqual([""]);
  });
});

describe("drillConfig", () => {
  it("binds the web Worker's local database with the given migrations", () => {
    expect(JSON.parse(drillConfig("drill", "/repo/m"))).toEqual({
      name: "drill",
      compatibility_date: "2026-10-01",
      d1_databases: [
        {
          binding: "DB",
          database_name: "sharerepo-dev",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: "/repo/m",
        },
      ],
    });
  });
});

/** A restored database as the fake Wrangler reports it. */
interface FakeDatabase {
  tables: Record<string, number>;
  objects: { type: string; name: string }[];
  migrations: string[];
  quickCheck: { quick_check: string }[];
  foreignKeys: { table: string; parent: string }[];
}

const MIGRATIONS = ["0000_init.sql", "0001_it's.sql"];

function restoredAsExported(): FakeDatabase {
  return {
    tables: { d1_migrations: 2, child: 2, parent: 1 },
    objects: [
      { type: "index", name: "child_parent_idx" },
      { type: "index", name: "parent_id_idx" },
      { type: "trigger", name: "parent_no_delete" },
      { type: "trigger", name: "bare_trigger" },
    ],
    migrations: [...MIGRATIONS],
    quickCheck: [{ quick_check: "ok" }],
    foreignKeys: [],
  };
}

function fakeDrillIo(
  options: {
    dump?: string;
    database?: FakeDatabase;
    repository?: string[];
    fail?: (args: readonly string[]) => CommandResult | undefined;
    localDatabase?: boolean;
    applyMigrations?: (database: FakeDatabase) => void;
  } = {},
) {
  const repository = options.repository ?? MIGRATIONS;
  const files = Object.fromEntries(
    repository.map((name) => [`/repo/packages/db/migrations/${name}`, "-- sql"]),
  );
  files["/repo/packages/db/migrations/meta/_journal.json"] = "{}";
  const base = memoryIo("/repo", files);
  const database = options.database ?? restoredAsExported();
  const calls: string[][] = [];
  const copies: [string, string][] = [];
  const removed: string[] = [];
  const ok = (stdout = ""): CommandResult => ({ status: 0, stdout, stderr: "" });
  const rows = (results: unknown[]) => ok(`noise\n${JSON.stringify([{ results }])}`);
  const io: DrillIo = {
    ...base,
    makeTempDir: (prefix) => `/tmp/${prefix}1`,
    copyDir: (from, to) => {
      copies.push([from, to]);
    },
    exists: (path) => (options.localDatabase ?? true) && path.endsWith("/v3/d1"),
    remove: (path) => {
      removed.push(path);
    },
    run(command, args, cwd) {
      expect(command).toBe("pnpm");
      expect(cwd).toBe("/repo");
      calls.push([...args]);
      const failed = options.fail?.(args);
      if (failed !== undefined) return failed;
      const [, , , subcommand] = args;
      if (subcommand === "export") {
        base.writeText(args[args.indexOf("--output") + 1] as string, options.dump ?? DUMP);
        return ok();
      }
      if (subcommand === "migrations") {
        options.applyMigrations?.(database);
        return ok();
      }
      if (!args.includes("--command")) return ok(); // the restore itself
      const sql = args[args.indexOf("--command") + 1] as string;
      if (sql.startsWith("SELECT name FROM sqlite_master")) {
        return rows(Object.keys(database.tables).map((name) => ({ name })));
      }
      if (sql.startsWith("SELECT (SELECT COUNT")) return rows([database.tables]);
      if (sql.startsWith("SELECT type, name")) return rows(database.objects);
      if (sql.startsWith("SELECT name FROM d1_migrations")) {
        return rows(database.migrations.map((name) => ({ name })));
      }
      if (sql === "PRAGMA quick_check") return rows(database.quickCheck);
      if (sql === "PRAGMA foreign_key_check") return rows(database.foreignKeys);
      throw new Error(`unexpected query ${sql}`);
    },
  };
  return { io, base, calls, copies, removed };
}

describe("run", () => {
  it("drills a copy of the local database and passes when the restore matches", () => {
    const { io, base, calls, copies, removed } = fakeDrillIo();
    expect(run([], io)).toBe(0);
    expect(copies).toEqual([
      [
        "/repo/apps/web/.wrangler/state/v3/d1",
        "/tmp/sharerepo-drill-1/source/.wrangler/state/v3/d1",
      ],
    ]);
    expect(calls[0]).toEqual([
      "exec",
      "wrangler",
      "d1",
      "export",
      "DB",
      "--local",
      "-c",
      "/tmp/sharerepo-drill-1/source/wrangler.jsonc",
      "--output",
      "/tmp/sharerepo-drill-1/backup.sql",
    ]);
    expect(calls[1]).toEqual([
      "exec",
      "wrangler",
      "d1",
      "execute",
      "DB",
      "--local",
      "-c",
      "/tmp/sharerepo-drill-1/restore/wrangler.jsonc",
      "--file",
      "/tmp/sharerepo-drill-1/restore.sql",
      "-y",
    ]);
    expect(base.files["/tmp/sharerepo-drill-1/restore.sql"]).toBe(orderForRestore(DUMP));
    expect(JSON.parse(base.files["/tmp/sharerepo-drill-1/restore/wrangler.jsonc"] ?? "")).toEqual(
      expect.objectContaining({ name: "sharerepo-drill-restore" }),
    );
    expect(calls.some((args) => args.includes("migrations"))).toBe(false);
    expect(base.logs.join("\n")).toContain("Tables: 3, rows restored: 5 (exported: 5)");
    expect(base.logs.join("\n")).toContain("Migrations: 2 in the backup, 0 applied by the drill");
    expect(base.logs.at(-1)).toBe("Drill passed.");
    expect(removed).toEqual(["/tmp/sharerepo-drill-1"]);
    expect(base.errors).toEqual([]);
  });

  it("reads a local database from another state directory, such as the E2E one", () => {
    const { io, copies } = fakeDrillIo();
    expect(run(["--persist-to", ".e2e/state", "--keep"], io)).toBe(0);
    expect(copies[0]?.[0]).toBe("/repo/.e2e/state/v3/d1");
  });

  it("keeps the scratch directory when asked", () => {
    const { io, base, removed } = fakeDrillIo();
    expect(run(["--keep"], io)).toBe(0);
    expect(removed).toEqual([]);
    expect(base.logs.join("\n")).toContain("Kept /tmp/sharerepo-drill-1");
  });

  it("exports a deployed database without copying anything", () => {
    const { io, calls, copies } = fakeDrillIo();
    expect(run(["--remote", "--env", "production"], io)).toBe(0);
    expect(copies).toEqual([]);
    expect(calls[0]).toEqual([
      "exec",
      "wrangler",
      "d1",
      "export",
      "DB",
      "--remote",
      "--env",
      "production",
      "-c",
      "/repo/apps/web/wrangler.jsonc",
      "--output",
      "/tmp/sharerepo-drill-1/backup.sql",
    ]);
    const top = fakeDrillIo();
    expect(run(["--remote"], top.io)).toBe(0);
    expect(top.calls[0]).not.toContain("--env");
  });

  it("applies the repository's pending migrations to the restored copy", () => {
    const repository = [...MIGRATIONS, "0002_next.sql"];
    const { io, base, calls } = fakeDrillIo({
      repository,
      applyMigrations: (database) => database.migrations.push("0002_next.sql"),
    });
    expect(run([], io)).toBe(0);
    expect(calls).toContainEqual([
      "exec",
      "wrangler",
      "d1",
      "migrations",
      "apply",
      "DB",
      "--local",
      "-c",
      "/tmp/sharerepo-drill-1/restore/wrangler.jsonc",
    ]);
    expect(base.logs.join("\n")).toContain("Applying 1 pending migration(s): 0002_next.sql");
  });

  it("fails, listing each difference, when the restore does not match", () => {
    const database = restoredAsExported();
    database.tables = { d1_migrations: 2, child: 1 };
    database.objects = [
      { type: "index", name: "child_parent_idx" },
      { type: "index", name: "extra_idx" },
      { type: "trigger", name: "parent_no_delete" },
    ];
    database.quickCheck = [{ quick_check: "row 3 missing from index" }];
    database.foreignKeys = [{ table: "child", parent: "parent" }];
    const { io, base, removed } = fakeDrillIo({
      database,
      repository: [...MIGRATIONS, "0002_next.sql"],
    });
    expect(run([], io)).toBe(1);
    expect(base.errors.join("\n")).toBe(
      [
        "Drill FAILED:",
        "  - child: exported 2 rows, restored 1",
        "  - parent: exported 1 rows, restored no table",
        "  - missing index parent_id_idx",
        "  - unexpected index extra_idx",
        "  - missing trigger bare_trigger",
        "  - migrations after restore: 0000_init.sql, 0001_it's.sql",
        "  - quick_check: row 3 missing from index",
        "  - foreign key: a child row has no parent",
      ].join("\n"),
    );
    expect(removed).toEqual(["/tmp/sharerepo-drill-1"]);
  });

  it("fails when the backup has migrations the repository does not know", () => {
    const database = restoredAsExported();
    database.quickCheck = [];
    database.migrations = [];
    const { io, base, calls } = fakeDrillIo({ database, repository: ["0000_other.sql"] });
    expect(run([], io)).toBe(1);
    expect(base.errors.join("\n")).toContain(
      "the backup's migrations (0000_init.sql, 0001_it's.sql) are not a prefix of the repository's",
    );
    expect(base.errors.join("\n")).toContain("quick_check: no result");
    expect(base.logs.join("\n")).toContain("quick_check: no result");
    expect(calls.some((args) => args.includes("migrations"))).toBe(false);
  });

  it("reports an empty backup's migrations and tables", () => {
    const database: FakeDatabase = {
      tables: {},
      objects: [],
      migrations: [],
      quickCheck: [{ quick_check: "ok" }],
      foreignKeys: [],
    };
    const { io, base } = fakeDrillIo({ dump: "", database, repository: ["0000_init.sql"] });
    expect(run([], io)).toBe(1);
    expect(base.errors.join("\n")).toContain("migrations after restore: none");
  });

  it("stops when a step fails, with Wrangler's output", () => {
    const failing = fakeDrillIo({
      fail: (args) =>
        args.includes("--file") ? { status: 1, stdout: "", stderr: "no such table" } : undefined,
    });
    expect(run([], failing.io)).toBe(2);
    expect(failing.base.errors[0]).toBe(
      "Drill step failed: wrangler d1 execute DB failed (exit 1):\nno such table",
    );
    expect(failing.removed).toEqual(["/tmp/sharerepo-drill-1"]);

    const quiet = fakeDrillIo({
      fail: (args) =>
        args.includes("export") ? { status: 3, stdout: "on stdout", stderr: "" } : undefined,
    });
    expect(run(["--keep"], quiet.io)).toBe(2);
    expect(quiet.base.errors[0]).toContain("(exit 3):\non stdout");
  });

  it("stops when a query returns no JSON or no result set", () => {
    const noJson = fakeDrillIo({
      fail: (args) =>
        args.includes("--json") ? { status: 0, stdout: "?", stderr: "" } : undefined,
    });
    expect(run([], noJson.io)).toBe(2);
    expect(noJson.base.errors[0]).toContain("no JSON result for: SELECT name FROM sqlite_master");

    const empty = fakeDrillIo({
      fail: (args) =>
        args.includes("--json") ? { status: 0, stdout: "[]", stderr: "" } : undefined,
    });
    expect(run([], empty.io)).toBe(1);
  });

  it("stops when there is no local database", () => {
    const { io, base } = fakeDrillIo({ localDatabase: false });
    expect(run([], io)).toBe(2);
    expect(base.errors[0]).toBe(
      "Drill step failed: no local D1 database under /repo/apps/web/.wrangler/state",
    );
  });

  it.each([
    [["--remote", "--persist-to", "x"], "--persist-to is for a local source"],
    [["--env", "production"], "--env selects a deployed database"],
    [["--unknown"], "Unknown option"],
  ])("refuses %j", (argv, message) => {
    const { io, base, calls } = fakeDrillIo();
    expect(run(argv, io)).toBe(2);
    expect(base.errors[0]).toContain(message);
    expect(base.errors[0]).toContain("Usage: node scripts/db-drill.ts");
    expect(calls).toEqual([]);
  });
});

describe("nodeDrillIo", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("makes, writes into, copies and removes scratch directories", () => {
    const dir = nodeDrillIo.makeTempDir("sharerepo-drill-test-");
    dirs.push(dir);
    nodeDrillIo.writeText(join(dir, "a/b/file.txt"), "text");
    nodeDrillIo.copyDir(join(dir, "a"), join(dir, "copy"));
    expect(readFileSync(join(dir, "copy/b/file.txt"), "utf8")).toBe("text");
    expect(nodeDrillIo.exists(join(dir, "copy"))).toBe(true);
    nodeDrillIo.remove(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it("runs a command and returns its exit code and output", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sharerepo-drill-run-"));
    dirs.push(cwd);
    expect(
      nodeDrillIo.run(
        process.execPath,
        ["-e", "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)"],
        cwd,
      ),
    ).toEqual({ status: 3, stdout: "out", stderr: "err" });
    expect(nodeDrillIo.run("sharerepo-no-such-command", [], cwd)).toEqual({
      status: 1,
      stdout: "",
      stderr: "",
    });
  });
});
