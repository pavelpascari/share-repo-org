import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { insertWorkspaceRow, uniqueId } from "./support/rows.ts";
import { type ConformanceExemption, checkTenantSchema } from "./support/schema-conformance.ts";

// These tests create temporary tenant tables in this file's isolated D1 storage and drop them
// afterwards, so the checker sees only the migrated schema plus the tables under test.
async function withTables<K extends string>(
  ddl: Record<K, string>,
  run: (names: Record<K, string>) => Promise<void>,
) {
  const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 8);
  const names = Object.fromEntries(
    Object.keys(ddl).map((key) => [key, `tmp_${key}_${suffix}`]),
  ) as Record<K, string>;
  const render = (sql: string) =>
    sql.replace(/\{(\w+)\}/g, (_, key: string) => names[key as K] ?? key);
  for (const sql of Object.values<string>(ddl)) await env.DB.prepare(render(sql)).run();
  try {
    await run(names);
  } finally {
    for (const name of Object.values<string>(names).reverse()) {
      await env.DB.prepare(`DROP TABLE IF EXISTS ${name}`).run();
    }
  }
}

async function violationsFor(
  names: Record<string, string>,
  exemptions: readonly ConformanceExemption[] = [],
) {
  const tables = new Set<string>(Object.values(names));
  return (await checkTenantSchema(env.DB, exemptions)).filter((v) => tables.has(v.table));
}

const resourcesDdl = `CREATE TABLE {resources} (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  UNIQUE (workspace_id, id)
)`;

const grantsDdl = `CREATE TABLE {grants} (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  resource_id TEXT NOT NULL,
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, resource_id) REFERENCES {resources}(workspace_id, id)
)`;

describe("isolation/composite-fk-rejects-cross-tenant-link: composite foreign keys", () => {
  it("rejects a cross-workspace link and accepts a same-workspace link", async () => {
    await withTables({ resources: resourcesDdl, grants: grantsDdl }, async (t) => {
      const workspaceA = uniqueId("ws");
      const workspaceB = uniqueId("ws");
      await insertWorkspaceRow({ id: workspaceA });
      await insertWorkspaceRow({ id: workspaceB });
      const resourceId = uniqueId("res");
      await env.DB.prepare(`INSERT INTO ${t.resources} (id, workspace_id) VALUES (?, ?)`)
        .bind(resourceId, workspaceA)
        .run();

      const insertGrant = (workspaceId: string) =>
        env.DB.prepare(`INSERT INTO ${t.grants} (id, workspace_id, resource_id) VALUES (?, ?, ?)`)
          .bind(uniqueId("grt"), workspaceId, resourceId)
          .run();

      await expect(insertGrant(workspaceB)).rejects.toThrow(/FOREIGN KEY constraint failed/);
      await expect(insertGrant(workspaceA)).resolves.toMatchObject({ success: true });
    });
  });
});

describe("schema conformance checker", () => {
  it("accepts conforming tenant tables", async () => {
    await withTables({ resources: resourcesDdl, grants: grantsDdl }, async (t) => {
      expect(await violationsFor(t)).toEqual([]);
    });
  });

  it("accepts a tenant key declared as a separate unique index", async () => {
    await withTables(
      {
        resources: `CREATE TABLE {resources} (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL)`,
        index: `CREATE UNIQUE INDEX {index} ON {resources} (id, workspace_id)`,
      },
      async (t) => {
        expect(await violationsFor(t)).toEqual([]);
      },
    );
  });

  it("ignores global tables without workspace_id", async () => {
    await withTables(
      {
        globals: `CREATE TABLE {globals} (id TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id))`,
      },
      async (t) => {
        expect(await violationsFor(t)).toEqual([]);
      },
    );
  });

  it("reports a tenant table without UNIQUE(workspace_id, id)", async () => {
    await withTables(
      { resources: `CREATE TABLE {resources} (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL)` },
      async (t) => {
        expect(await violationsFor(t)).toEqual([
          expect.objectContaining({ table: t.resources, rule: "tenant-key" }),
        ]);
      },
    );
  });

  it.each([
    [
      "a partial unique index",
      "CREATE UNIQUE INDEX {index} ON {resources} (workspace_id, id) WHERE id <> ''",
    ],
    ["a non-unique index", "CREATE INDEX {index} ON {resources} (workspace_id, id)"],
    ["a wider unique index", "CREATE UNIQUE INDEX {index} ON {resources} (workspace_id, id, name)"],
    [
      "a unique index on other columns",
      "CREATE UNIQUE INDEX {index} ON {resources} (workspace_id, name)",
    ],
  ])("does not accept %s as the tenant key", async (_, indexDdl) => {
    await withTables(
      {
        resources: `CREATE TABLE {resources} (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT)`,
        index: indexDdl,
      },
      async (t) => {
        expect(await violationsFor(t)).toEqual([
          expect.objectContaining({ table: t.resources, rule: "tenant-key" }),
        ]);
      },
    );
  });

  it("does not accept a composite primary key that does not start with workspace_id", async () => {
    await withTables(
      {
        links: `CREATE TABLE {links} (
          user_id TEXT NOT NULL, workspace_id TEXT NOT NULL, PRIMARY KEY (user_id, workspace_id)
        )`,
      },
      async (t) => {
        expect(await violationsFor(t)).toEqual([
          expect.objectContaining({ table: t.links, rule: "tenant-key" }),
        ]);
      },
    );
  });

  it("reports a nullable workspace_id", async () => {
    await withTables(
      {
        resources: `CREATE TABLE {resources} (
          id TEXT PRIMARY KEY, workspace_id TEXT, UNIQUE (workspace_id, id)
        )`,
      },
      async (t) => {
        expect(await violationsFor(t)).toEqual([
          expect.objectContaining({ table: t.resources, rule: "workspace-id-not-null" }),
        ]);
      },
    );
  });

  it("reports a single-column reference to another tenant table", async () => {
    await withTables(
      {
        resources: resourcesDdl,
        grants: `CREATE TABLE {grants} (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL,
          resource_id TEXT NOT NULL REFERENCES {resources}(id),
          UNIQUE (workspace_id, id)
        )`,
      },
      async (t) => {
        expect(await violationsFor(t)).toEqual([
          {
            table: t.grants,
            rule: "composite-fk",
            detail: `(resource_id->id) references ${t.resources}`,
          },
        ]);
      },
    );
  });

  it("reports a composite reference to a tenant table that skips workspace_id", async () => {
    await withTables(
      {
        resources: `CREATE TABLE {resources} (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, name TEXT NOT NULL,
          UNIQUE (workspace_id, id), UNIQUE (id, name)
        )`,
        grants: `CREATE TABLE {grants} (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT, resource_name TEXT,
          UNIQUE (workspace_id, id),
          FOREIGN KEY (resource_id, resource_name) REFERENCES {resources}(id, name)
        )`,
      },
      async (t) => {
        expect(await violationsFor(t)).toEqual([
          expect.objectContaining({ table: t.grants, rule: "composite-fk" }),
        ]);
      },
    );
  });

  it("resolves an implicit reference to the parent's primary key", async () => {
    await withTables(
      {
        resources: resourcesDdl,
        grants: `CREATE TABLE {grants} (
          id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, resource_id TEXT REFERENCES {resources},
          UNIQUE (workspace_id, id)
        )`,
      },
      async (t) => {
        expect(await violationsFor(t)).toEqual([
          {
            table: t.grants,
            rule: "composite-fk",
            detail: `(resource_id->id) references ${t.resources}`,
          },
        ]);
      },
    );
  });

  it("reports a reference to workspaces from a column other than workspace_id", async () => {
    await withTables(
      {
        transfers: `CREATE TABLE {transfers} (
          id TEXT PRIMARY KEY,
          workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          target_workspace_id TEXT NOT NULL REFERENCES workspaces(id),
          UNIQUE (workspace_id, id)
        )`,
      },
      async (t) => {
        expect(await violationsFor(t)).toEqual([
          {
            table: t.transfers,
            rule: "root-fk",
            detail: "(target_workspace_id->id) references workspaces",
          },
        ]);
      },
    );
  });

  it("skips exempt tables", async () => {
    await withTables(
      { legacy: `CREATE TABLE {legacy} (id TEXT PRIMARY KEY, workspace_id TEXT)` },
      async (t) => {
        expect(await violationsFor(t)).toHaveLength(2);
        expect(await violationsFor(t, [{ table: t.legacy, reason: "test" }])).toEqual([]);
      },
    );
  });
});
