import { env } from "cloudflare:workers";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { describe, expect, it } from "vitest";
import { schema } from "../src/index.ts";

// CI also checks that `drizzle-kit generate` produces no diff; this catches the same drift
// locally: every constraint declared in the Drizzle schema exists in the migrated database.
describe("drizzle schema matches the migrated database", () => {
  it.each(Object.values(schema).map((table) => [getTableConfig(table).name, table] as const))(
    "%s declares the same CHECK constraints and foreign keys as the migrations",
    async (name, table) => {
      const config = getTableConfig(table);
      const row = await env.DB.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
      )
        .bind(name)
        .first<{ sql: string }>();
      const ddl = row?.sql ?? "";
      const migratedChecks = [...ddl.matchAll(/CONSTRAINT "([^"]+)" CHECK/g)].map((m) => m[1]);
      expect(config.checks.map((check) => check.name).sort()).toEqual(migratedChecks.sort());

      const { results } = await env.DB.prepare(`PRAGMA foreign_key_list("${name}")`).all<{
        table: string;
        on_delete: string;
      }>();
      expect(
        config.foreignKeys.map((fk) => ({
          table: getTableConfig(fk.reference().foreignTable).name,
          on_delete: (fk.onDelete ?? "no action").toUpperCase(),
        })),
      ).toEqual(
        expect.arrayContaining(results.map(({ table, on_delete }) => ({ table, on_delete }))),
      );
      expect(config.foreignKeys).toHaveLength(results.length);
    },
  );
});
