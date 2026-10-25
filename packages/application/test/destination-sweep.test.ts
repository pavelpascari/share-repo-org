import { env } from "cloudflare:workers";
import { getPaddleConnection } from "@sharerepo/db";
import { destinationDescription, PaddleApiError } from "@sharerepo/integrations";
import { ConflictError } from "@sharerepo/platform";
import { describe, expect, it } from "vitest";
import {
  connectPaddle,
  disconnectPaddle,
  ORPHANED_DESTINATION_GRACE_MS,
  reconnectPaddle,
  rotatePaddleWebhookSecret,
  sweepPaddleSubscriptions,
} from "../src/index.ts";
import { shop } from "./support/commerce.ts";
import { clock, db, serviceContext } from "./support/context.ts";
import {
  auditOf,
  commerceDeps,
  connectionOf,
  PaddleAccounts,
  type PaddleShop,
  paddleShop,
} from "./support/paddle.ts";

// Orphaned Paddle destinations (Phase 6 risk fixes): ShareRepo tags each destination it creates
// with its workspace and creation instant, and deletes the workspace's own destinations that no
// stored row names — never another app's, another workspace's, or one young enough to be in
// flight.

const BASE = "https://sharerepo.test";
const HOUR = 60 * 60 * 1000;
const EVENTS = ["subscription.updated"];

/** A destination as ShareRepo would have created it for `workspaceId`, `age` ago. */
async function tagged(
  s: PaddleShop,
  options: { workspaceId?: string; connectionId?: string; age: number; marker: string },
): Promise<string> {
  const created = await s.paddle.createNotificationSetting({
    description: destinationDescription({
      workspaceId: options.workspaceId ?? s.workspaceId,
      createdAt: clock.now() - options.age,
    }),
    destination: `${BASE}/webhooks/paddle/${options.connectionId ?? s.connectionId}?v=${options.marker}`,
    events: EVENTS,
  });
  return created.id;
}

const ids = (s: PaddleShop) => s.paddle.notificationSettings().map((setting) => setting.id);
const ref = (s: PaddleShop) => ({ workspaceId: s.workspaceId, connectionId: s.connectionId });
const dailySweep = (s: PaddleShop) => sweepPaddleSubscriptions(serviceContext(), ref(s), s.deps);
const rotate = (s: PaddleShop, ctx = serviceContext()) =>
  rotatePaddleWebhookSecret(ctx, s, s.slug, s.deps);

describe("paddle/orphaned-destinations-swept", () => {
  it("paddle/orphaned-destinations-swept: the daily sweep deletes only the workspace's own unnamed destinations past the grace", async () => {
    const s = await paddleShop();
    const current = (await connectionOf(s)).destinationId as string;
    const orphan = await tagged(s, { age: 2 * HOUR, marker: "orphan" });
    const young = await tagged(s, { age: 10 * 60 * 1000, marker: "young" });
    const otherWorkspace = await tagged(s, {
      workspaceId: "another-workspace",
      connectionId: "another-connection",
      age: 2 * HOUR,
      marker: "other",
    });
    // An untagged Phase 5 destination of this connection, and one of an unknown connection.
    const legacy = (
      await s.paddle.createNotificationSetting({
        description: "ShareRepo",
        destination: `${BASE}/webhooks/paddle/${s.connectionId}?v=legacy`,
        events: EVENTS,
      })
    ).id;
    const legacyElsewhere = (
      await s.paddle.createNotificationSetting({
        description: "ShareRepo",
        destination: `${BASE}/webhooks/paddle/someone-else`,
        events: EVENTS,
      })
    ).id;
    // Same URL shape, but a description ShareRepo never writes; and this workspace's tag on
    // another host.
    const lookalike = (
      await s.paddle.createNotificationSetting({
        description: "My own hook",
        destination: `${BASE}/webhooks/paddle/${s.connectionId}?v=mine`,
        events: EVENTS,
      })
    ).id;
    const elsewhere = (
      await s.paddle.createNotificationSetting({
        description: destinationDescription({
          workspaceId: s.workspaceId,
          createdAt: clock.now() - 2 * HOUR,
        }),
        destination: `https://elsewhere.example/webhooks/paddle/${s.connectionId}`,
        events: EVENTS,
      })
    ).id;
    s.paddle.addForeignDestinations(1);
    const foreign = (await s.paddle.listNotificationSettings()).find(
      (setting) => setting.description === "Another app",
    )?.id as string;

    expect(await dailySweep(s)).toMatchObject({ destinationsDeleted: 2 });
    expect(new Set(ids(s))).toEqual(
      new Set([current, young, otherWorkspace, legacyElsewhere, lookalike, elsewhere]),
    );
    expect((await s.paddle.listNotificationSettings()).map((setting) => setting.id)).toContain(
      foreign,
    );
    expect(await auditOf(s.workspaceId, "paddle.destinations_swept")).toEqual([
      {
        actor_type: "system",
        actor_id: null,
        target_id: s.workspaceId,
        reason: null,
        details: { reason: "orphaned", destinationIds: [orphan, legacy].sort() },
      },
    ]);

    // Idempotent: nothing more to delete, nothing more audited.
    expect(await dailySweep(s)).toMatchObject({ destinationsDeleted: 0 });
    expect(await auditOf(s.workspaceId, "paddle.destinations_swept")).toHaveLength(1);

    // The young one is deleted once it is past the grace and still unnamed.
    clock.advance(ORPHANED_DESTINATION_GRACE_MS);
    expect(await dailySweep(s)).toMatchObject({ destinationsDeleted: 1 });
    expect(ids(s)).not.toContain(young);
    expect(ids(s)).toContain(current);
  });

  it("keeps a rotation's stored second destination, however old", async () => {
    const s = await paddleShop();
    s.paddle.failNext("deleteNotificationSetting", "transient");
    await expect(rotate(s)).rejects.toBeInstanceOf(PaddleApiError);
    const pending = (await connectionOf(s)).destinationNextId as string;
    clock.advance(2 * HOUR);
    expect(await dailySweep(s)).toMatchObject({ destinationsDeleted: 0 });
    expect(ids(s)).toContain(pending);
    expect(await rotate(s)).toMatchObject({ ok: true, destinationId: pending });
  });

  it("treats a rate limit or an outage as retryable, and finishes after a failure part-way", async () => {
    const s = await paddleShop();
    const first = await tagged(s, { age: 2 * HOUR, marker: "a" });
    const second = await tagged(s, { age: 2 * HOUR, marker: "b" });
    s.paddle.failNext("listNotificationSettings", "rate_limited", { retryAfterMs: 30_000 });
    const limited = await dailySweep(s).catch((error: unknown) => error);
    expect(limited).toMatchObject({ kind: "rate_limited", retryAfterMs: 30_000 });
    expect(ids(s)).toEqual(expect.arrayContaining([first, second]));

    // The audit event comes before the deletions: a failure after it leaves a record, and the
    // retry deletes what is left, recording it again.
    const [early, late] = [first, second].sort() as [string, string];
    s.paddle.failNext("deleteNotificationSetting", "transient");
    await expect(dailySweep(s)).rejects.toMatchObject({ kind: "transient" });
    expect(await dailySweep(s)).toMatchObject({ destinationsDeleted: 2 });
    expect(ids(s)).not.toContain(early);
    expect(ids(s)).not.toContain(late);
    expect(
      (await auditOf(s.workspaceId, "paddle.destinations_swept")).map((e) => e.details),
    ).toEqual([
      { reason: "orphaned", destinationIds: [early, late] },
      { reason: "orphaned", destinationIds: [early, late] },
    ]);
  });

  it("deletes a destination whose create response was lost at connect, or leaves it to the daily sweep when Paddle stays down", async () => {
    const s = await shop();
    const accounts = new PaddleAccounts();
    const { fake, key } = accounts.seller();
    const deps = commerceDeps(accounts);
    const input = { apiKey: key, apiKeyExpiresOn: null };
    fake.loseNextResponse("createNotificationSetting");
    await expect(connectPaddle(serviceContext(), s, s.slug, input, deps)).rejects.toBeInstanceOf(
      PaddleApiError,
    );
    // Deleted at once: the attempt's URL named a connection ID only that attempt used.
    expect(fake.notificationSettings()).toEqual([]);
    expect(await auditOf(s.workspaceId, "paddle.destinations_swept")).toHaveLength(1);

    // Lost again, and Paddle cannot list it now: it stays, unknown to ShareRepo.
    fake.loseNextResponse("createNotificationSetting");
    fake.failNext("listNotificationSettings", "transient");
    await expect(connectPaddle(serviceContext(), s, s.slug, input, deps)).rejects.toBeInstanceOf(
      PaddleApiError,
    );
    const [lost] = fake.notificationSettings();
    const connected = await connectPaddle(serviceContext(), s, s.slug, input, deps);
    if (!connected.ok) throw new Error("connect failed");
    // Too young for the sweep after connecting: it might have been a create in flight.
    expect(fake.notificationSettings().map((setting) => setting.id)).toContain(lost?.id);
    clock.advance(ORPHANED_DESTINATION_GRACE_MS);
    const swept = await sweepPaddleSubscriptions(
      serviceContext(),
      { workspaceId: s.workspaceId, connectionId: connected.connectionId },
      deps,
    );
    expect(swept).toMatchObject({ destinationsDeleted: 1 });
    const stored = await getPaddleConnection(db, { workspaceId: s.workspaceId });
    expect(fake.notificationSettings().map((setting) => setting.id)).toEqual([
      stored?.destinationId,
    ]);
  });

  it("makes room for a connect by deleting the workspace's old orphans when the seller has 10", async () => {
    const s = await shop();
    const accounts = new PaddleAccounts();
    const { fake, key } = accounts.seller();
    const deps = commerceDeps(accounts);
    fake.addForeignDestinations(9);
    const orphan = await fake.createNotificationSetting({
      description: destinationDescription({
        workspaceId: s.workspaceId,
        createdAt: clock.now() - 2 * HOUR,
      }),
      destination: `${BASE}/webhooks/paddle/crashed-attempt`,
      events: EVENTS,
    });
    const connected = await connectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: key, apiKeyExpiresOn: null },
      deps,
    );
    expect(connected).toMatchObject({ ok: true });
    const listed = (await fake.listNotificationSettings()).map((setting) => setting.id);
    expect(listed).not.toContain(orphan.id);
    expect(listed).toHaveLength(10);
  });

  it("deletes every destination of the workspace when disconnecting, an unstored one included", async () => {
    const s = await paddleShop();
    // A rotation's second destination, created a moment ago and not stored (its Worker stopped).
    const unstored = await tagged(s, { age: 0, marker: "unstored" });
    const result = await disconnectPaddle(serviceContext(), s, s.slug, s.deps);
    expect(result).toMatchObject({
      ok: true,
      destinationDeleted: true,
      orphanedDestinationIds: [],
    });
    expect(ids(s)).toEqual([]);
    const [swept] = await auditOf(s.workspaceId, "paddle.destinations_swept");
    expect(swept?.details).toMatchObject({ reason: "disconnected" });
    expect(swept?.details.destinationIds).toContain(unstored);
  });

  it("a disconnect racing a rotation that stores its second destination deletes that one too", async () => {
    const s = await paddleShop();
    const before = await connectionOf(s);
    let racer = "";
    let armed = true;
    const ctx = {
      ...serviceContext(),
      db: new Proxy(db, {
        get: (target, property, receiver) => {
          if (property !== "batch") return Reflect.get(target, property, receiver);
          return async (...args: Parameters<typeof target.batch>) => {
            if (armed) {
              armed = false;
              // The rotation creates and stores its second destination after the disconnect
              // listed the seller's destinations.
              racer = await tagged(s, { age: 0, marker: "racer" });
              await env.DB.prepare(
                "UPDATE paddle_connections SET destination_next_id = ?, webhook_secret_next_envelope = webhook_secret_envelope WHERE id = ?",
              )
                .bind(racer, s.connectionId)
                .run();
            }
            return target.batch(...args);
          };
        },
      }),
    };
    const result = await disconnectPaddle(ctx, s, s.slug, s.deps);
    expect(result).toMatchObject({ ok: true, destinationId: before.destinationId });
    expect(racer).not.toBe("");
    expect(ids(s)).toEqual([]);
    expect(await getPaddleConnection(db, { workspaceId: s.workspaceId })).toBeNull();
  });

  it("refuses a disconnect whose connection keeps changing under it", async () => {
    const s = await paddleShop();
    let n = 0;
    const ctx = {
      ...serviceContext(),
      db: new Proxy(db, {
        get: (target, property, receiver) => {
          if (property !== "batch") return Reflect.get(target, property, receiver);
          return async (...args: Parameters<typeof target.batch>) => {
            n += 1;
            await env.DB.prepare(
              "UPDATE paddle_connections SET destination_next_id = ?, webhook_secret_next_envelope = webhook_secret_envelope WHERE id = ?",
            )
              .bind(`ntfset_${String(n).padStart(26, "9")}`, s.connectionId)
              .run();
            return target.batch(...args);
          };
        },
      }),
    };
    await expect(disconnectPaddle(ctx, s, s.slug, s.deps)).rejects.toBeInstanceOf(ConflictError);
    expect(await getPaddleConnection(db, { workspaceId: s.workspaceId })).toMatchObject({
      status: "active",
    });
  });

  it("sweeps after a reconnect and after a completed rotation", async () => {
    const s = await paddleShop();
    const orphan = await tagged(s, { age: 2 * HOUR, marker: "r1" });
    const reconnected = await reconnectPaddle(
      serviceContext(),
      s,
      s.slug,
      { apiKey: s.key, apiKeyExpiresOn: null },
      s.deps,
    );
    expect(reconnected).toMatchObject({ ok: true });
    expect(ids(s)).not.toContain(orphan);
    const another = await tagged(s, { age: 2 * HOUR, marker: "r2" });
    expect(await rotate(s)).toMatchObject({ ok: true });
    expect(ids(s)).not.toContain(another);
    expect(ids(s)).toEqual([(await connectionOf(s)).destinationId]);
  });
});
