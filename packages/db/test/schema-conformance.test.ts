import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type ConformanceExemption, checkTenantSchema } from "./support/schema-conformance.ts";

// Tables that may break the tenant-key conventions, each with a reason. Keep this list short.
// workspace_memberships needs no entry: its composite primary key starts with workspace_id and
// its only workspace reference is workspace_id -> workspaces(id).
const EXEMPTIONS: readonly ConformanceExemption[] = [
  {
    table: "audit_events",
    reason:
      "Holds account-scoped events with no workspace, so workspace_id is nullable; workspace rows " +
      "reference the root workspaces table directly (decision 0007).",
  },
  {
    table: "outbox",
    reason:
      "System-wide work (the sweeps) has no workspace, so workspace_id is nullable and references " +
      "the root workspaces table directly. A row's subject differs by kind, so no composite key " +
      "can tie it to one table; the key's workspace prefix is checked by the jobs (decision 0014).",
  },
];

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
