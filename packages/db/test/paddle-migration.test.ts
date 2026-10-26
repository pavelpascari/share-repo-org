import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const upTo = (name: string) => {
  const index = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith(name));
  return env.TEST_MIGRATIONS.slice(0, index + 1);
};

const ENVELOPE = '{"v":1}';

/** Inserts a Paddle connection, which a Paddle event must reference after 0006. */
async function paddleConnection(db: D1Database, id: string, workspaceId: string) {
  await db
    .prepare(
      "INSERT INTO workspaces (id, slug, name, status, created_at, updated_at) VALUES (?, ?, 'Acme', 'active', 1, 1)",
    )
    .bind(workspaceId, `acme-${workspaceId}`)
    .run();
  await db
    .prepare(
      `INSERT INTO paddle_connections (id, workspace_id, environment, seller_id, credential_kind,
         api_key_envelope, destination_id, webhook_secret_envelope, status, created_at, updated_at)
       VALUES (?, ?, 'sandbox', 'slr_1', 'api_key', ?, 'ntfset_1', ?, 'active', 1, 1)`,
    )
    .bind(id, workspaceId, ENVELOPE, ENVELOPE)
    .run();
}

const insertEvent = (db: D1Database, id: string, provider: string, connectionId: string | null) =>
  db
    .prepare(
      `INSERT INTO external_events (id, provider, connection_id, external_event_id, event_type,
         payload_digest, received_at, processing_state, attempts)
       VALUES (?, ?, ?, 'evt_shared', 'subscription.updated', 'sha256:x', 1, 'pending', 0)`,
    )
    .bind(id, provider, connectionId)
    .run();

describe("migration 0006 (Paddle and claims)", () => {
  it("rebuilds external_events and the outbox with their existing rows", async () => {
    const db = env.UPGRADE_DB;
    await applyD1Migrations(db, upTo("0005_"));
    await db
      .prepare(
        `INSERT INTO external_events (id, provider, external_event_id, event_type, action,
           installation_id, payload_digest, received_at, processing_state, attempts,
           last_error_code, processed_at)
         VALUES ('e1', 'github', 'd1', 'installation', 'created', '42', 'sha256:a', 10, 'processed', 1, NULL, 11),
                ('e2', 'github', 'd2', 'push', NULL, NULL, 'sha256:b', 12, 'failed', 3, 'transient', NULL)`,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts, sent_at, failed_at, last_error_code) VALUES ('o1', 'reconcile_resource', 'k1', 1, 2, 3, NULL, 4, 'rejected')",
      )
      .run();
    const sweep =
      "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts) VALUES ('o2', 'sweep_paddle_subscriptions', 'k2', 1, 1, 0)";
    await expect(db.prepare(sweep).run()).rejects.toThrow(/CHECK constraint failed/);

    // Through every later migration too: 0007 adds `external_subscription_id`, null for old rows.
    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    const events = await db.prepare("SELECT * FROM external_events ORDER BY id").all();
    expect(events.results).toEqual([
      {
        id: "e1",
        provider: "github",
        connection_id: null,
        external_event_id: "d1",
        event_type: "installation",
        action: "created",
        installation_id: "42",
        payload_digest: "sha256:a",
        external_subscription_id: null,
        occurred_at: null,
        received_at: 10,
        processing_state: "processed",
        attempts: 1,
        last_error_code: null,
        processed_at: 11,
      },
      {
        id: "e2",
        provider: "github",
        connection_id: null,
        external_event_id: "d2",
        event_type: "push",
        action: null,
        installation_id: null,
        payload_digest: "sha256:b",
        external_subscription_id: null,
        occurred_at: null,
        received_at: 12,
        processing_state: "failed",
        attempts: 3,
        last_error_code: "transient",
        processed_at: null,
      },
    ]);
    expect((await db.prepare("SELECT * FROM outbox").all()).results).toEqual([
      {
        id: "o1",
        kind: "reconcile_resource",
        subject_id: "k1",
        created_at: 1,
        available_at: 2,
        attempts: 3,
        sent_at: null,
        failed_at: 4,
        last_error_code: "rejected",
        // Added by migration 0009 (failure records).
        workspace_id: null,
        dismissed_at: null,
        dismissed_by: null,
        dismiss_reason: null,
      },
    ]);
    await db.prepare(sweep).run();
    for (const kind of ["send_claim_email", "check_paddle_connection"]) {
      await db
        .prepare(
          "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts) VALUES (?, ?, 'k', 1, 1, 0)",
        )
        .bind(`o-${kind}`, kind)
        .run();
    }

    const indexes = async (table: string) =>
      (
        await db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?")
          .bind(table)
          .all<{ name: string }>()
      ).results.map((row) => row.name);
    expect(await indexes("outbox")).toContain("outbox_pending_idx");
    expect(await indexes("external_events")).toEqual(
      expect.arrayContaining([
        "external_events_state_idx",
        "external_events_connection_event_unique",
      ]),
    );
    expect(await indexes("external_events")).not.toContain("external_events_provider_event_unique");
  });

  it("scopes event deduplication to the connection, and still dedupes GitHub", async () => {
    const db = env.UPGRADE_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    await paddleConnection(db, "pc1", "w1");
    await paddleConnection(db, "pc2", "w2");

    // A creator who signs a colliding `evt_` ID cannot suppress another workspace's event.
    await insertEvent(db, "p1", "paddle", "pc1");
    await insertEvent(db, "p2", "paddle", "pc2");
    await expect(insertEvent(db, "p3", "paddle", "pc1")).rejects.toThrow(/UNIQUE constraint/);

    // GitHub events have no connection; coalesce makes the nulls collide.
    await insertEvent(db, "g1", "github", null);
    await expect(insertEvent(db, "g2", "github", null)).rejects.toThrow(/UNIQUE constraint/);

    // A redelivery is skipped by ON CONFLICT DO NOTHING without a target.
    const skipped = await db
      .prepare(
        `INSERT INTO external_events (id, provider, connection_id, external_event_id, event_type,
           payload_digest, received_at, processing_state, attempts)
         VALUES ('p4', 'paddle', 'pc2', 'evt_shared', 'x', 'sha256:x', 1, 'pending', 0)
         ON CONFLICT DO NOTHING`,
      )
      .run();
    expect(skipped.meta.changes).toBe(0);
  });
});
