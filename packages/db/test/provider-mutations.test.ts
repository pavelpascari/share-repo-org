import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { type ProviderMutation, schema } from "../src/index.ts";
import { db } from "./support/connections.ts";
import {
  grantRow,
  leasedWorkspace,
  mutationRow,
  seedGrant,
  seedMutation,
} from "./support/reconcile.ts";
import { T0 } from "./support/rows.ts";

async function seeded() {
  const ws = await leasedWorkspace();
  const grant = await seedGrant(grantRow(ws.identity));
  return { ws, grant };
}

/** Inserts through D1 directly, so a failure surfaces SQLite's own message. */
function insertMutation(row: ProviderMutation) {
  const query = db.insert(schema.providerMutations).values(row).toSQL();
  return env.DB.prepare(query.sql)
    .bind(...query.params)
    .run();
}

const run = (statement: string, ...params: unknown[]) =>
  env.DB.prepare(statement)
    .bind(...params)
    .run();

describe("provider_mutations triggers", () => {
  it("settles once, from started, and changes nothing else", async () => {
    const { grant } = await seeded();
    const mutation = await seedMutation(mutationRow(grant));
    await expect(
      run(
        "UPDATE provider_mutations SET status = 'started', correlation_id = 'other' WHERE id = ?",
        mutation.id,
      ),
    ).rejects.toThrow(/settle once/);
    await expect(
      run(
        "UPDATE provider_mutations SET status = 'succeeded', finished_at = ?, started_at = ? WHERE id = ?",
        T0 + 2,
        T0 + 1,
        mutation.id,
      ),
    ).rejects.toThrow(/settle once/);
    for (const column of [
      "workspace_id",
      "connection_id",
      "grant_id",
      "subject_id",
      "resource_id",
      "operation",
      "access_level",
      "entitlement_ids",
      "id",
    ]) {
      await expect(
        run(
          `UPDATE provider_mutations SET status = 'succeeded', finished_at = ?, ${column} = ${column} || 'x' WHERE id = ?`,
          T0 + 1,
          mutation.id,
        ),
      ).rejects.toThrow(/settle once/);
    }

    await run(
      "UPDATE provider_mutations SET status = 'succeeded', finished_at = ?, external_id = 'inv1' WHERE id = ?",
      T0 + 1,
      mutation.id,
    );
    await expect(
      run(
        "UPDATE provider_mutations SET status = 'failed', error_code = 'x', retry_class = 'retryable' WHERE id = ?",
        mutation.id,
      ),
    ).rejects.toThrow(/settle once/);
    await expect(
      run("UPDATE provider_mutations SET external_id = 'inv2' WHERE id = ?", mutation.id),
    ).rejects.toThrow(/settle once/);
  });

  it("never deletes a started row outside a purge", async () => {
    const { grant } = await seeded();
    const mutation = await seedMutation(mutationRow(grant));
    await expect(run("DELETE FROM provider_mutations WHERE id = ?", mutation.id)).rejects.toThrow(
      /append-only/,
    );
  });
});

describe("provider_mutations checks", () => {
  const cases: [string, Partial<ProviderMutation>, string][] = [
    [
      "a failure without a code",
      { status: "failed", finishedAt: T0, retryClass: "retryable" },
      "provider_mutations_failure_classified",
    ],
    [
      "a failure without a class",
      { status: "failed", finishedAt: T0, errorCode: "x" },
      "provider_mutations_failure_classified",
    ],
    [
      "a success with an error",
      { status: "succeeded", finishedAt: T0, errorCode: "x", retryClass: "retryable" },
      "provider_mutations_failure_classified",
    ],
    ["a started row with an end", { finishedAt: T0 }, "provider_mutations_finished"],
    ["a settled row without an end", { status: "resolved" }, "provider_mutations_finished"],
    [
      "an end before the start",
      { status: "succeeded", startedAt: T0, finishedAt: T0 - 1 },
      "provider_mutations_finished",
    ],
    [
      "entitlement IDs that are an object",
      { entitlementIds: "{}" },
      "provider_mutations_entitlement_ids_json",
    ],
    [
      "entitlement IDs that are not JSON",
      { entitlementIds: "[" },
      "provider_mutations_entitlement_ids_json",
    ],
  ];

  for (const [name, overrides, constraint] of cases) {
    it(`rejects ${name}`, async () => {
      const { grant } = await seeded();
      await expect(insertMutation(mutationRow(grant, overrides))).rejects.toThrow(
        new RegExp(`CHECK constraint failed: ${constraint}`),
      );
    });
  }

  it("accepts each settled outcome", async () => {
    const { grant } = await seeded();
    const ids = JSON.stringify(["ent_1", "ent_2"]);
    for (const overrides of [
      { status: "succeeded", finishedAt: T0 },
      { status: "resolved", finishedAt: T0 },
      { status: "failed", finishedAt: T0, errorCode: "rate_limited", retryClass: "rate_limited" },
    ] as const) {
      await expect(
        insertMutation(mutationRow(grant, { ...overrides, entitlementIds: ids })),
      ).resolves.toBeDefined();
    }
  });
});

describe("isolation/composite-fk-rejects-cross-tenant-link: provider_mutations", () => {
  it("rejects a mutation naming another workspace's grant, resource, subject or connection", async () => {
    const { ws, grant } = await seeded();
    const other = await seeded();
    for (const overrides of [
      { grantId: other.grant.id },
      { resourceId: other.ws.resource.id },
      { subjectId: other.ws.subject.id },
      { connectionId: other.ws.connection.id },
    ]) {
      await expect(insertMutation(mutationRow(grant, overrides))).rejects.toThrow(/FOREIGN KEY/);
    }
    // The same IDs under their own workspace are accepted.
    await expect(insertMutation(mutationRow(other.grant))).resolves.toBeDefined();
    expect(ws.workspaceId).not.toBe(other.ws.workspaceId);
  });
});
