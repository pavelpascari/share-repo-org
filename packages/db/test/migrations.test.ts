import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

// The setup file applied every migration to this file's empty D1 storage.
describe("migrations", () => {
  it("are read from flat NNNN_name.sql files, the layout drizzle-kit and Wrangler share", () => {
    expect(env.TEST_MIGRATIONS.length).toBeGreaterThan(0);
    for (const migration of env.TEST_MIGRATIONS) {
      expect(migration.name).toMatch(/^\d{4}_[a-z0-9_]+\.sql$/);
    }
  });

  it("apply from empty and are recorded in order", async () => {
    const { results } = await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY id").all<{
      name: string;
    }>();
    expect(results.map((row) => row.name)).toEqual(env.TEST_MIGRATIONS.map((m) => m.name));
  });

  it("create the v0 tables", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('users', 'workspaces', 'workspace_memberships') ORDER BY name",
    ).all<{ name: string }>();
    expect(results.map((row) => row.name)).toEqual([
      "users",
      "workspace_memberships",
      "workspaces",
    ]);
  });

  it("run with foreign key enforcement on", async () => {
    const row = await env.DB.prepare("PRAGMA foreign_keys").first<{ foreign_keys: number }>();
    expect(row?.foreign_keys).toBe(1);
  });

  it("are a no-op when applied again", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    const row = await env.DB.prepare("SELECT count(*) AS n FROM d1_migrations").first<{
      n: number;
    }>();
    expect(row?.n).toBe(env.TEST_MIGRATIONS.length);
  });
});
