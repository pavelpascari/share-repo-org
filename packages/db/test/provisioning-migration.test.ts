import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const upTo = (name: string) => {
  const index = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith(name));
  return env.TEST_MIGRATIONS.slice(0, index + 1);
};

describe("migration 0005 (provisioning)", () => {
  it("rebuilds the outbox with its existing rows and accepts reconcile_resource", async () => {
    const db = env.UPGRADE_DB;
    await applyD1Migrations(db, upTo("0004_"));
    await db
      .prepare(
        "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts, sent_at, failed_at, last_error_code) VALUES ('o1', 'refresh_subscription', 'k1', 1, 2, 3, NULL, 4, 'rejected'), ('o2', 'recompute_offer', 'k2', 5, 6, 0, 7, NULL, NULL)",
      )
      .run();
    const reconcile =
      "INSERT INTO outbox (id, kind, subject_id, created_at, available_at, attempts) VALUES ('o3', 'reconcile_resource', 'k3', 1, 1, 0)";
    await expect(db.prepare(reconcile).run()).rejects.toThrow(/CHECK constraint failed/);

    await applyD1Migrations(db, env.TEST_MIGRATIONS);

    const { results } = await db.prepare("SELECT * FROM outbox ORDER BY id").all();
    expect(results).toEqual([
      {
        id: "o1",
        kind: "refresh_subscription",
        subject_id: "k1",
        created_at: 1,
        available_at: 2,
        attempts: 3,
        sent_at: null,
        failed_at: 4,
        last_error_code: "rejected",
      },
      {
        id: "o2",
        kind: "recompute_offer",
        subject_id: "k2",
        created_at: 5,
        available_at: 6,
        attempts: 0,
        sent_at: 7,
        failed_at: null,
        last_error_code: null,
      },
    ]);
    await db.prepare(reconcile).run();
    const indexes = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'outbox'")
      .all<{ name: string }>();
    expect(indexes.results.map((row) => row.name)).toContain("outbox_pending_idx");
  });

  it("adds the reconciliation columns with safe defaults", async () => {
    const db = env.UPGRADE_DB;
    await applyD1Migrations(db, env.TEST_MIGRATIONS);
    const columns = async (table: string) =>
      (
        await db
          .prepare(
            `SELECT name, "notnull" AS required, dflt_value AS fallback FROM pragma_table_info('${table}')`,
          )
          .all<{ name: string; required: number; fallback: string | null }>()
      ).results;
    expect(await columns("grants")).toEqual(
      expect.arrayContaining([
        { name: "indirect", required: 1, fallback: "false" },
        { name: "next_attempt_at", required: 0, fallback: null },
      ]),
    );
    expect(await columns("resources")).toEqual(
      expect.arrayContaining(
        ["next_reconcile_at", "last_reconciled_at", "reconcile_token", "reconcile_lease_until"].map(
          (name) => ({ name, required: 0, fallback: null }),
        ),
      ),
    );
  });
});
