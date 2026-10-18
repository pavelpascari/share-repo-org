import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type ConformanceExemption, checkTenantSchema } from "./support/schema-conformance.ts";

// Tables that may break the tenant-key conventions, each with a reason. Keep this list short.
// workspace_memberships needs no entry: its composite primary key starts with workspace_id and
// its only workspace reference is workspace_id -> workspaces(id).
const EXEMPTIONS: readonly ConformanceExemption[] = [];

describe("isolation/composite-fk-rejects-cross-tenant-link: migrated schema", () => {
  it("every tenant table has UNIQUE(workspace_id, id) and composite tenant foreign keys", async () => {
    await expect(checkTenantSchema(env.DB, EXEMPTIONS)).resolves.toEqual([]);
  });

  it("treats workspace_memberships as a tenant table", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('workspace_memberships') WHERE name = 'workspace_id'",
    ).all();
    expect(results).toHaveLength(1);
  });
});
