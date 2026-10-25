import { env } from "cloudflare:workers";
import { pruneCutoffs } from "@sharerepo/domain";
import { describe, expect, it } from "vitest";
import {
  cancelWorkspaceDeletion,
  finishPurge,
  isForeignKeyViolation,
  PRUNABLE,
  PURGE_ORDER,
  pruneExpiredData,
  purgeBatch,
  purgeProgress,
  purgeTableHasRows,
  scheduleWorkspaceDeletion,
  schema,
} from "../src/index.ts";
import { accountEvent, workspaceEvent } from "./support/audit.ts";
import { customerRow, outboxRow, subscribedWorkspace } from "./support/commerce.ts";
import { count, db } from "./support/connections.ts";
import { checkoutClaimRow, claimRequestRow, claimTokenRow, hexDigest } from "./support/paddle.ts";
import { grantRow, mutationRow, seedGrant, seedMutation } from "./support/reconcile.ts";
import { insertUserRow, insertWorkspaceRow, T0, uniqueId } from "./support/rows.ts";

// Storage for the data lifecycle (decision 0015): what pruning may delete, and the bounded,
// workspace-scoped purge batches.

const DAY = 86_400_000;
const NOW = T0 + 400 * DAY;
const OLD = NOW - 200 * DAY;

const run = (query: string, ...params: unknown[]) =>
  env.DB.prepare(query)
    .bind(...params)
    .run();
const exists = async (table: string, id: string, key = "id") =>
  (await count(table, `${key} = ?`, id)) === 1;

function externalEvent(
  receivedAt: number,
  state: "pending" | "processed" | "ignored" | "failed" = "processed",
) {
  const id = uniqueId("evt");
  return run(
    `INSERT INTO external_events (id, provider, external_event_id, event_type, payload_digest,
       received_at, processing_state, attempts) VALUES (?, 'github', ?, 'push', ?, ?, ?, 0)`,
    id,
    id,
    hexDigest(),
    receivedAt,
    state,
  ).then(() => id);
}

async function sessionAndVerification(expiresAt: number) {
  const userId = uniqueId("usr");
  await insertUserRow(userId);
  await run(
    `INSERT INTO auth_users (id, name, email, email_verified, created_at, updated_at)
     VALUES (?, 'n', ?, 1, ?, ?)`,
    userId,
    `${userId}@users.sharerepo.invalid`,
    T0,
    T0,
  );
  const sessionId = uniqueId("ses");
  await run(
    `INSERT INTO auth_sessions (id, user_id, token, expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    sessionId,
    userId,
    uniqueId("tok"),
    expiresAt,
    T0,
    T0,
  );
  const verificationId = uniqueId("ver");
  await run(
    `INSERT INTO auth_verifications (id, identifier, value, expires_at, created_at, updated_at)
     VALUES (?, 'state', 'v', ?, ?, ?)`,
    verificationId,
    expiresAt,
    T0,
    T0,
  );
  return { sessionId, verificationId };
}

describe("retention/prune-keeps-referenced-rows", () => {
  it("deletes what is past its period and keeps what something still references", async () => {
    const cutoffs = pruneCutoffs(NOW);
    const ws = await subscribedWorkspace();
    const { workspaceId, userId } = ws;

    // Received events: handled and old go; pending, recent, or still read by a job stay.
    const oldEvent = await externalEvent(OLD);
    const oldIgnored = await externalEvent(OLD, "ignored");
    const pendingEvent = await externalEvent(OLD, "pending");
    const recentEvent = await externalEvent(NOW - DAY);
    const readEvent = await externalEvent(OLD, "failed");
    const reading = outboxRow("process_external_event", readEvent);
    await db
      .insert(schema.outbox)
      .values({ ...reading, attempts: 3, failedAt: OLD, lastErrorCode: "x" });

    // Outbox: sent over 7 days ago, or dismissed over 90 days ago, goes.
    const sentOld = outboxRow("resync_connection", "c1");
    const sentRecent = outboxRow("resync_connection", "c2");
    const dismissedOld = outboxRow("resync_connection", "c3");
    const failedOpen = outboxRow("resync_connection", "c4");
    await db.insert(schema.outbox).values([
      { ...sentOld, attempts: 1, sentAt: NOW - 8 * DAY },
      { ...sentRecent, attempts: 1, sentAt: NOW - 6 * DAY },
      {
        ...dismissedOld,
        attempts: 10,
        failedAt: OLD,
        lastErrorCode: "x",
        dismissedAt: NOW - 91 * DAY,
        dismissedBy: "op",
        dismissReason: "fixed",
      },
      { ...failedOpen, attempts: 10, failedAt: OLD, lastErrorCode: "x" },
    ]);

    // Claims: used or expired over 30 days ago goes; a checkout claim whose customer is still
    // linked stays.
    const unlinked = customerRow(workspaceId);
    await db.insert(schema.customers).values(unlinked);
    const tokenExpired = claimTokenRow(workspaceId, ws.customer.id, {
      createdAt: OLD - DAY,
      expiresAt: OLD,
    });
    const tokenUsed = claimTokenRow(workspaceId, ws.customer.id, {
      createdAt: OLD - DAY,
      expiresAt: NOW + DAY,
      consumedAt: OLD,
      consumedByUserId: userId,
    });
    const tokenRecent = claimTokenRow(workspaceId, ws.customer.id, {
      createdAt: NOW - 2 * DAY,
      expiresAt: NOW - DAY,
    });
    await db.insert(schema.claimTokens).values([tokenExpired, tokenUsed, tokenRecent]);
    const requestDone = claimRequestRow(workspaceId, userId, {
      emailEnvelope: null,
      createdAt: OLD,
      processedAt: OLD,
    });
    const requestOpen = claimRequestRow(workspaceId, userId, { createdAt: OLD });
    await db.insert(schema.claimRequests).values([requestDone, requestOpen]);
    const offerId = ws.offer.offer.id;
    const checkoutExpired = checkoutClaimRow(workspaceId, userId, offerId, {
      createdAt: OLD - DAY,
      expiresAt: OLD,
    });
    const checkoutLinked = checkoutClaimRow(workspaceId, userId, offerId, {
      createdAt: OLD - DAY,
      expiresAt: OLD,
      consumedByCustomerId: ws.customer.id,
      consumedAt: OLD,
    });
    const checkoutUnlinked = checkoutClaimRow(workspaceId, userId, offerId, {
      createdAt: OLD - DAY,
      expiresAt: OLD,
      consumedByCustomerId: unlinked.id,
      consumedAt: OLD,
    });
    const checkoutOpen = checkoutClaimRow(workspaceId, userId, offerId, {
      createdAt: NOW - DAY,
      expiresAt: NOW + DAY,
    });
    await db
      .insert(schema.checkoutClaims)
      .values([checkoutExpired, checkoutLinked, checkoutUnlinked, checkoutOpen]);

    // Rate-limit counters whose (at most a day long) window has ended go.
    await db.insert(schema.claimRateLimits).values([
      { bucket: "user:old:h", windowStart: NOW - 2 * DAY, count: 1 },
      { bucket: "user:new:d", windowStart: NOW - DAY / 2, count: 1 },
    ]);

    // Provider mutations: settled over 90 days ago goes; `started` never does.
    const grant = await seedGrant(
      grantRow({
        workspaceId,
        connectionId: ws.connection.id,
        subjectId: ws.subject.id,
        resourceId: ws.resource.id,
      }),
    );
    const settled = await seedMutation(
      mutationRow(grant, { status: "succeeded", startedAt: OLD, finishedAt: OLD }),
    );
    const started = await seedMutation(mutationRow(grant, { startedAt: OLD }));
    const settledRecent = await seedMutation(
      mutationRow(grant, { status: "succeeded", startedAt: NOW - DAY, finishedAt: NOW - DAY }),
    );

    // Better Auth rows expired over 7 days ago go.
    const expired = await sessionAndVerification(NOW - 8 * DAY);
    const current = await sessionAndVerification(NOW + DAY);

    // A user row an account deletion left, once nothing names it; one still named stays.
    const orphan = uniqueId("usr");
    await insertUserRow(orphan, OLD);
    const named = uniqueId("usr");
    await insertUserRow(named, OLD);
    await db
      .insert(schema.claimRequests)
      .values(claimRequestRow(workspaceId, named, { createdAt: OLD }));
    const fresh = uniqueId("usr");
    await insertUserRow(fresh, NOW - DAY / 2);

    const audit = accountEvent({ action: "data.pruned" });
    let counted: Record<string, number> = {};
    const deleted = await pruneExpiredData(db, {
      cutoffs,
      limit: 500,
      audit: (counts) => {
        counted = { ...counts };
        return [{ ...audit, details: { deleted: counts } }];
      },
    });
    expect(deleted).toEqual(counted);
    expect(Object.keys(deleted).sort()).toEqual(Object.keys(PRUNABLE).sort());

    const gone = async (table: string, ids: string[], key = "id") => {
      for (const id of ids) expect(await exists(table, id, key), `${table} ${id}`).toBe(false);
    };
    const kept = async (table: string, ids: string[], key = "id") => {
      for (const id of ids) expect(await exists(table, id, key), `${table} ${id}`).toBe(true);
    };
    await gone("external_events", [oldEvent, oldIgnored]);
    await kept("external_events", [pendingEvent, recentEvent, readEvent]);
    await gone("outbox", [sentOld.id, dismissedOld.id]);
    await kept("outbox", [sentRecent.id, failedOpen.id, reading.id]);
    await gone("claim_tokens", [tokenExpired.id, tokenUsed.id]);
    await kept("claim_tokens", [tokenRecent.id]);
    await gone("claim_requests", [requestDone.id]);
    await kept("claim_requests", [requestOpen.id]);
    await gone("checkout_claims", [checkoutExpired.id, checkoutUnlinked.id]);
    await kept("checkout_claims", [checkoutLinked.id, checkoutOpen.id]);
    await gone("claim_rate_limits", ["user:old:h"], "bucket");
    await kept("claim_rate_limits", ["user:new:d"], "bucket");
    await gone("provider_mutations", [settled.id]);
    await kept("provider_mutations", [started.id, settledRecent.id]);
    await gone("auth_sessions", [expired.sessionId]);
    await gone("auth_verifications", [expired.verificationId]);
    await kept("auth_sessions", [current.sessionId]);
    await kept("auth_verifications", [current.verificationId]);
    await gone("users", [orphan]);
    await kept("users", [named, fresh, userId]);

    const stored = await env.DB.prepare("SELECT details FROM audit_events WHERE id = ?")
      .bind(audit.id)
      .first<{ details: string }>();
    expect(JSON.parse(stored?.details ?? "{}")).toEqual({ deleted });
    expect(deleted).toMatchObject({
      external_events: 2,
      outbox: 2,
      claim_tokens: 2,
      claim_requests: 1,
      checkout_claims: 2,
      claim_rate_limits: 1,
      provider_mutations: 1,
      auth_sessions: 1,
      auth_verifications: 1,
      users: 1,
    });

    // A second run finds nothing more, and still records that it ran.
    const again = await pruneExpiredData(db, {
      cutoffs,
      limit: 500,
      audit: (counts) => [accountEvent({ details: { deleted: counts } })],
    });
    expect(Object.values(again).every((n) => n === 0)).toBe(true);
  });

  it("deletes at most `limit` rows per table in one run", async () => {
    const rows = [1, 2, 3].map((i) => outboxRow("resync_connection", `bounded-${i}`));
    await db
      .insert(schema.outbox)
      .values(rows.map((row) => ({ ...row, attempts: 1, sentAt: NOW - 8 * DAY })));
    const prune = () =>
      pruneExpiredData(db, {
        cutoffs: pruneCutoffs(NOW),
        limit: 2,
        audit: (counts) => [accountEvent({ details: { deleted: counts } })],
      });
    expect((await prune()).outbox).toBe(2);
    expect((await prune()).outbox).toBe(1);
    expect((await prune()).outbox).toBe(0);
  });
});

describe("workspace deletion storage", () => {
  async function workspace(status = "active") {
    const id = uniqueId("ws");
    await insertWorkspaceRow({ id });
    if (status !== "active") {
      await run(
        "UPDATE workspaces SET status = ?, delete_after = ?, deletion_requested_by = 'u' WHERE id = ?",
        status,
        T0,
        id,
      );
    }
    return id;
  }

  it("schedules a deletion only from active, and cancels only from deleting", async () => {
    const id = await workspace();
    const schedule = () =>
      scheduleWorkspaceDeletion(
        db,
        { workspaceId: id, requestedBy: "usr_1", now: T0, deleteAfter: T0 + 30 * DAY },
        [workspaceEvent(id)],
      );
    expect(await schedule()).toEqual({ ok: true });
    expect(await schedule()).toEqual({ ok: false });
    const cancel = () =>
      cancelWorkspaceDeletion(db, { workspaceId: id, now: T0 + DAY, sources: ["simulated"] }, [
        workspaceEvent(id),
      ]);
    expect(await cancel()).toEqual({ ok: true });
    expect(await cancel()).toEqual({ ok: false });
    // Two audit events: one per change that happened.
    expect(await count("audit_events", "workspace_id = ?", id)).toBe(2);
  });

  it("purges in bounded batches only while purging, and counts what each deleted", async () => {
    const ws = await subscribedWorkspace();
    const id = ws.workspaceId;
    await db
      .insert(schema.outbox)
      .values(
        [1, 2, 3].map((i) => ({ ...outboxRow("resync_connection", `p-${i}`, id), attempts: 0 })),
      );
    // Not being deleted: nothing is deleted, even when asked to start.
    expect(
      await purgeBatch(db, { workspaceId: id, table: "outbox", limit: 2, now: NOW, start: true }),
    ).toEqual({ deleted: 0, purging: false });
    expect(await count("outbox", "workspace_id = ?", id)).toBe(3);

    await run(
      "UPDATE workspaces SET status = 'deleting', delete_after = ?, deletion_requested_by = 'u' WHERE id = ?",
      NOW,
      id,
    );
    // A live entitlement holds the purge back.
    expect(
      await purgeBatch(db, { workspaceId: id, table: "outbox", limit: 2, now: NOW, start: true }),
    ).toEqual({ deleted: 0, purging: false });
    await run(
      "UPDATE entitlements SET state = 'revoked', ended_at = ? WHERE workspace_id = ?",
      NOW,
      id,
    );
    // So does a managed grant.
    const grant = await seedGrant(
      grantRow(
        {
          workspaceId: id,
          connectionId: ws.connection.id,
          subjectId: ws.subject.id,
          resourceId: ws.resource.id,
        },
        { managed: true },
      ),
    );
    expect(
      (await purgeBatch(db, { workspaceId: id, table: "outbox", limit: 2, now: NOW, start: true }))
        .purging,
    ).toBe(false);
    await run("UPDATE grants SET managed = 0, state = 'absent' WHERE id = ?", grant.id);
    // Not before delete_after either.
    expect(
      (
        await purgeBatch(db, {
          workspaceId: id,
          table: "outbox",
          limit: 2,
          now: NOW - 1,
          start: true,
        })
      ).purging,
    ).toBe(false);

    expect(
      await purgeBatch(db, { workspaceId: id, table: "outbox", limit: 2, now: NOW, start: true }),
    ).toEqual({ deleted: 2, purging: true });
    expect(
      await purgeBatch(db, { workspaceId: id, table: "outbox", limit: 2, now: NOW, start: false }),
    ).toEqual({ deleted: 1, purging: true });
    expect(await purgeTableHasRows(db, { workspaceId: id, table: "outbox" })).toBe(false);
    expect(await purgeTableHasRows(db, { workspaceId: id, table: "grants" })).toBe(true);
    expect(await purgeProgress(db, id)).toEqual({ outbox: 3 });

    // The workspace row cannot go while its rows remain: the foreign keys refuse.
    const error = await finishPurge(db, {
      workspaceId: id,
      audit: (deleted) => [accountEvent({ details: { deleted } })],
    }).catch((e: unknown) => e);
    expect(isForeignKeyViolation(error)).toBe(true);

    for (const table of PURGE_ORDER) {
      while (
        (await purgeBatch(db, { workspaceId: id, table, limit: 500, now: NOW, start: false }))
          .deleted > 0
      ) {
        // Until the table is empty.
      }
    }
    const tombstone = accountEvent({ action: "workspace.purged" });
    expect(
      await finishPurge(db, {
        workspaceId: id,
        audit: (deleted) => [{ ...tombstone, details: { deleted } }],
      }),
    ).toBe(true);
    expect(await count("workspaces", "id = ?", id)).toBe(0);
    expect(await count("audit_events", "id = ?", tombstone.id)).toBe(1);
    expect(await count("system_state", "key LIKE ?", `%${id}`)).toBe(0);
    // A repeat finds nothing to delete and writes no second tombstone.
    expect(
      await finishPurge(db, {
        workspaceId: id,
        audit: (deleted) => [accountEvent({ action: "workspace.purged", details: { deleted } })],
      }),
    ).toBe(false);
    expect(
      await count("audit_events", "action = 'workspace.purged' AND details LIKE ?", "%workspaces%"),
    ).toBe(1);
  });

  it("refuses to purge a table a workspace does not own", async () => {
    await expect(
      purgeBatch(db, { workspaceId: "w", table: "users", limit: 1, now: NOW, start: false }),
    ).rejects.toThrow("not a workspace-owned table");
    await expect(purgeTableHasRows(db, { workspaceId: "w", table: "users" })).rejects.toThrow(
      "not a workspace-owned table",
    );
  });

  it("classifies only foreign key failures as such", () => {
    expect(isForeignKeyViolation(new Error("FOREIGN KEY constraint failed"))).toBe(true);
    expect(
      isForeignKeyViolation(
        new Error("wrapped", { cause: new Error("FOREIGN KEY constraint failed") }),
      ),
    ).toBe(true);
    expect(isForeignKeyViolation(new Error("UNIQUE constraint failed: a.b"))).toBe(false);
    expect(isForeignKeyViolation("FOREIGN KEY constraint failed")).toBe(false);
  });

  it("names every workspace-owned table", async () => {
    const { results } = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND sql LIKE '%workspace_id%'",
    ).all<{ name: string }>();
    const owned = [...results.map((r) => r.name), "external_events"].sort();
    expect([...PURGE_ORDER].sort()).toEqual(owned);
  });
});
