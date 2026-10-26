import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const upTo = (name: string) => {
  const index = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith(name));
  return env.TEST_MIGRATIONS.slice(0, index + 1);
};

const ENVELOPE = '{"v":1}';

/**
 * A populated 0008 database: two workspaces (active and suspended) with members, audit history,
 * a Paddle connection with a price and an event, and outbox rows. `workspaces` and
 * `paddle_connections` are referenced by every one of them.
 */
async function seed0008(db: D1Database) {
  await applyD1Migrations(db, upTo("0008_"));
  const statements = [
    "INSERT INTO users (id, created_at, updated_at) VALUES ('u1', 1, 1)",
    `INSERT INTO workspaces (id, slug, name, status, created_at, updated_at)
       VALUES ('w1', 'acme', 'Acme', 'active', 1, 2), ('w2', 'beta', 'Beta', 'suspended', 3, 4)`,
    `INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at)
       VALUES ('w1', 'u1', 'owner', 1), ('w2', 'u1', 'owner', 3)`,
    `INSERT INTO audit_events (id, scope, workspace_id, actor_type, actor_id, action, target_type,
       target_id, correlation_id, occurred_at, details)
       VALUES ('a1', 'workspace', 'w1', 'user', 'u1', 'workspace.created', 'workspace', 'w1', 'c1', 1, '{}'),
              ('a2', 'account', NULL, 'user', 'u1', 'user.created', 'user', 'u1', 'c2', 1, '{}')`,
    `INSERT INTO paddle_connections (id, workspace_id, environment, seller_id, credential_kind,
       api_key_envelope, destination_id, webhook_secret_envelope, status, created_at, updated_at)
       VALUES ('pc1', 'w1', 'sandbox', 'slr_1', 'api_key', '${ENVELOPE}', 'ntfset_1', '${ENVELOPE}', 'active', 1, 1)`,
    `INSERT INTO paddle_prices (id, workspace_id, connection_id, price_id, product_id, product_name,
       unit_amount, currency, status, synced_at)
       VALUES ('pp1', 'w1', 'pc1', 'pri_1', 'pro_1', 'Pro', '1000', 'USD', 'active', 1)`,
    `INSERT INTO external_events (id, provider, connection_id, external_event_id, event_type,
       payload_digest, received_at, processing_state, attempts)
       VALUES ('e1', 'paddle', 'pc1', 'evt_1', 'subscription.updated', 'sha256:x', 1, 'processed', 1)`,
    `INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts, sent_at,
       failed_at, last_error_code)
       VALUES ('o1', 'reconcile_resource', 'w1:r1', 1, 2, 5, NULL, 3, 'rejected')`,
  ];
  for (const statement of statements) await db.prepare(statement).run();
}

const names = async (db: D1Database, type: string) =>
  (
    await db
      .prepare("SELECT name FROM sqlite_master WHERE type = ? ORDER BY name")
      .bind(type)
      .all<{ name: string }>()
  ).results.map((row) => row.name);

describe("migration 0009 (operational hardening)", () => {
  it("rebuilds workspaces, paddle_connections and the outbox with their rows and references", async () => {
    const db = env.UPGRADE_DB;
    await seed0008(db);
    const triggersBefore = await names(db, "trigger");

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    expect((await db.prepare("SELECT * FROM workspaces ORDER BY id").all()).results).toEqual([
      {
        id: "w1",
        slug: "acme",
        name: "Acme",
        status: "active",
        created_at: 1,
        updated_at: 2,
        delete_after: null,
        deletion_requested_by: null,
      },
      {
        id: "w2",
        slug: "beta",
        name: "Beta",
        status: "suspended",
        created_at: 3,
        updated_at: 4,
        delete_after: null,
        deletion_requested_by: null,
      },
    ]);
    expect(
      await db
        .prepare(
          "SELECT destination_id, webhook_secret_envelope, destination_next_id, webhook_secret_next_envelope FROM paddle_connections",
        )
        .first(),
    ).toEqual({
      destination_id: "ntfset_1",
      webhook_secret_envelope: ENVELOPE,
      destination_next_id: null,
      webhook_secret_next_envelope: null,
    });
    expect(await db.prepare("SELECT * FROM outbox").first()).toEqual({
      id: "o1",
      kind: "reconcile_resource",
      subject_id: "w1:r1",
      created_at: 1,
      available_at: 2,
      attempts: 5,
      sent_at: null,
      failed_at: 3,
      last_error_code: "rejected",
      workspace_id: null,
      dismissed_at: null,
      dismissed_by: null,
      dismiss_reason: null,
    });
    for (const [table, n] of [
      ["workspace_memberships", 2],
      ["audit_events", 2],
      ["paddle_prices", 1],
      ["external_events", 1],
    ] as const) {
      const row = await db.prepare(`SELECT count(*) AS n FROM ${table}`).first<{ n: number }>();
      expect(row?.n, table).toBe(n);
    }

    // Every reference still resolves, and is still enforced.
    expect((await db.prepare("PRAGMA foreign_key_check").all()).results).toEqual([]);
    await expect(
      db
        .prepare(
          "INSERT INTO workspace_memberships (workspace_id, user_id, role, created_at) VALUES ('w9', 'u1', 'owner', 1)",
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(
      db
        .prepare(
          `INSERT INTO paddle_prices (id, workspace_id, connection_id, price_id, product_id,
             product_name, unit_amount, currency, status, synced_at)
             VALUES ('pp2', 'w1', 'pc9', 'pri_2', 'pro_1', 'Pro', '1000', 'USD', 'active', 1)`,
        )
        .run(),
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
    await expect(db.prepare("DELETE FROM workspaces WHERE id = 'w2'").run()).rejects.toThrow(
      /FOREIGN KEY constraint failed/,
    );

    // The rebuilt tables keep their indexes, and no trigger is lost.
    expect(await names(db, "index")).toEqual(
      expect.arrayContaining([
        "workspaces_slug_unique",
        "paddle_connections_one_live",
        "paddle_connections_workspace_id_id_unique",
        "external_events_connection_event_unique",
        "outbox_pending_idx",
        "outbox_pending_subject_idx",
        "outbox_open_failures_idx",
        "entitlements_state_valid_until_idx",
        "external_events_received_idx",
        "checkout_claims_expires_idx",
        "claim_requests_created_idx",
        "claim_tokens_expires_idx",
        "provider_mutations_finished_idx",
      ]),
    );
    expect(await names(db, "trigger")).toEqual(
      [
        ...triggersBefore,
        "workspaces_created_live",
        "workspaces_purging_one_way",
        // Migration 0011, applied with the rest.
        "external_identities_user_not_deleted",
      ].sort(),
    );
    await expect(
      db
        .prepare(
          "INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES ('w3', 'acme', 'X', 'active', 1, 1)",
        )
        .run(),
    ).rejects.toThrow(/UNIQUE constraint failed/);
  });

  it("re-creates the delete triggers with the purging exception only", async () => {
    const db = env.UPGRADE_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    const sql = async (name: string) =>
      (
        await db
          .prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
          .bind(name)
          .first<{ sql: string }>()
      )?.sql;
    for (const name of [
      "audit_events_no_delete",
      "offer_versions_no_delete",
      "provider_mutations_no_delete",
    ]) {
      expect(await sql(name)).toContain(
        "(SELECT status FROM workspaces WHERE id = OLD.workspace_id) IS NOT 'purging'",
      );
    }
    for (const name of ["audit_events_no_update", "offer_versions_no_update"]) {
      expect(await sql(name)).not.toContain("purging");
    }
  });
});
