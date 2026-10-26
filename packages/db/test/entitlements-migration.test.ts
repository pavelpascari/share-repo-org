import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const upTo = (name: string) => {
  const index = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith(name));
  return env.TEST_MIGRATIONS.slice(0, index + 1);
};

describe("migration 0004 (entitlements core)", () => {
  it("rebuilds the outbox with its existing rows and accepts the new kinds", async () => {
    const db = env.UPGRADE_DB;
    await applyD1Migrations(db, upTo("0003_"));
    await db
      .prepare(
        "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts, sent_at, failed_at, last_error_code) VALUES ('o1', 'resync_connection', 'c1', 1, 2, 3, NULL, 4, 'rejected'), ('o2', 'process_external_event', 'e1', 5, 6, 0, 7, NULL, NULL)",
      )
      .run();
    await expect(
      db
        .prepare(
          "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts) VALUES ('o3', 'refresh_subscription', 's1', 1, 1, 0)",
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    const { results } = await db.prepare("SELECT * FROM outbox ORDER BY id").all();
    expect(results).toEqual([
      {
        id: "o1",
        kind: "resync_connection",
        subject_id: "c1",
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
      {
        id: "o2",
        kind: "process_external_event",
        subject_id: "e1",
        created_at: 5,
        available_at: 6,
        attempts: 0,
        sent_at: 7,
        failed_at: null,
        last_error_code: null,
        // Added by migration 0009 (failure records).
        workspace_id: null,
        dismissed_at: null,
        dismissed_by: null,
        dismiss_reason: null,
      },
    ]);
    for (const kind of ["refresh_subscription", "recompute_offer"]) {
      await db
        .prepare(
          "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts) VALUES (?, ?, 'x', 1, 1, 0)",
        )
        .bind(`new-${kind}`, kind)
        .run();
    }
    await expect(
      db
        .prepare(
          "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts) VALUES ('bad', 'unknown', 'x', 1, 1, 0)",
        )
        .run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    const index = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outbox'")
      .all<{ name: string }>();
    expect(index.results.map((row) => row.name)).toContain("outbox_pending_idx");
  });
});
