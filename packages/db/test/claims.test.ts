import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import {
  consumeCheckoutClaim,
  consumeClaimToken,
  createCheckoutClaim,
  createClaimRequest,
  createClaimTokens,
  findClaimTokenByHash,
  finishClaimRequest,
  getCheckoutClaim,
  getClaimRequest,
  hitRateLimits,
  type NewClaimToken,
  schema,
  setCheckoutClaimTransaction,
} from "../src/index.ts";
import { auditCount, workspaceEvent } from "./support/audit.ts";
import { customerRow, outboxRow, seedOffer } from "./support/commerce.ts";
import { count, db, workspaceWithOwner } from "./support/connections.ts";
import { ENVELOPE, hexDigest } from "./support/paddle.ts";
import { insertUserRow, T0, uniqueId } from "./support/rows.ts";

const DAY = 86_400_000;
const NOW = T0 + 60_000;

/** A workspace with an offer, a buyer (not a member) and two customers. */
async function claimWorkspace() {
  const { workspaceId, userId } = await workspaceWithOwner();
  const buyer = uniqueId("usr");
  await insertUserRow(buyer);
  const offer = await seedOffer({ workspaceId, userId, resourceIds: [] });
  const customer = customerRow(workspaceId, { source: "paddle" });
  const otherCustomer = customerRow(workspaceId, { source: "paddle" });
  await db.insert(schema.customers).values([customer, otherCustomer]);
  return { workspaceId, buyer, offerId: offer.offer.id, customer, otherCustomer };
}

type Ws = Awaited<ReturnType<typeof claimWorkspace>>;

async function checkoutClaim(ws: Ws, overrides: { expiresAt?: number } = {}) {
  const event = workspaceEvent(ws.workspaceId);
  const claim = await createCheckoutClaim(
    db,
    {
      id: uniqueId("ckc"),
      workspaceId: ws.workspaceId,
      userId: ws.buyer,
      offerId: ws.offerId,
      priceId: "pri_01",
      createdAt: T0,
      expiresAt: overrides.expiresAt ?? T0 + 7 * DAY,
    },
    [event],
  );
  return { claim, event };
}

function tokenRow(ws: Ws, overrides: Partial<NewClaimToken> = {}): NewClaimToken {
  return {
    id: uniqueId("clt"),
    workspaceId: ws.workspaceId,
    customerId: ws.customer.id,
    tokenHash: hexDigest(),
    createdAt: T0,
    expiresAt: T0 + DAY,
    ...overrides,
  };
}

describe("checkout claims", () => {
  it("are created unconsumed with their audit event", async () => {
    const ws = await claimWorkspace();
    const { claim, event } = await checkoutClaim(ws);
    expect(claim).toMatchObject({
      transactionId: null,
      consumedByCustomerId: null,
      consumedAt: null,
    });
    expect(await getCheckoutClaim(db, { workspaceId: ws.workspaceId, id: claim.id })).toEqual(
      claim,
    );
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("isolation/cross-workspace-read-denied: are read only in their workspace", async () => {
    const ws = await claimWorkspace();
    const other = await claimWorkspace();
    const { claim } = await checkoutClaim(ws);
    expect(await getCheckoutClaim(db, { workspaceId: other.workspaceId, id: claim.id })).toBeNull();
  });

  it("record their transaction once, with optional audit", async () => {
    const ws = await claimWorkspace();
    const { claim } = await checkoutClaim(ws);
    const key = { workspaceId: ws.workspaceId, id: claim.id };
    const event = workspaceEvent(ws.workspaceId);
    expect(
      await setCheckoutClaimTransaction(db, { ...key, transactionId: "txn_1" }, [event]),
    ).toEqual({
      ok: true,
    });
    const again = workspaceEvent(ws.workspaceId);
    expect(
      await setCheckoutClaimTransaction(db, { ...key, transactionId: "txn_2" }, [again]),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await setCheckoutClaimTransaction(db, { ...key, transactionId: "txn_3" })).toEqual({
      ok: false,
      reason: "stale",
    });
    expect((await getCheckoutClaim(db, key))?.transactionId).toBe("txn_1");
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    expect(await auditCount(env.DB, again.correlationId)).toBe(0);
    expect(
      await setCheckoutClaimTransaction(db, {
        workspaceId: (await claimWorkspace()).workspaceId,
        id: claim.id,
        transactionId: "txn_x",
      }),
    ).toEqual({ ok: false, reason: "stale" });
  });

  it("claim/checkout-reference-tamper-rejected: are consumed by one customer only", async () => {
    const ws = await claimWorkspace();
    const { claim } = await checkoutClaim(ws);
    const key = { workspaceId: ws.workspaceId, id: claim.id };
    const event = workspaceEvent(ws.workspaceId);
    expect(
      await consumeCheckoutClaim(db, { ...key, customerId: ws.customer.id, now: NOW }, [event]),
    ).toEqual({ ok: true, first: true });
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    // A renewal of the same customer, after the claim's expiry, stays valid and writes nothing.
    const renewal = workspaceEvent(ws.workspaceId);
    expect(
      await consumeCheckoutClaim(db, { ...key, customerId: ws.customer.id, now: T0 + 40 * DAY }, [
        renewal,
      ]),
    ).toEqual({ ok: true, first: false });
    expect(await auditCount(env.DB, renewal.correlationId)).toBe(0);
    expect(
      await consumeCheckoutClaim(db, { ...key, customerId: ws.otherCustomer.id, now: NOW }),
    ).toEqual({ ok: false, reason: "consumed_by_other_customer" });
    expect(await getCheckoutClaim(db, key)).toMatchObject({
      consumedByCustomerId: ws.customer.id,
      consumedAt: NOW,
    });
  });

  it("claim/checkout-reference-tamper-rejected: an expired, unknown or other-workspace claim consumes nothing", async () => {
    const ws = await claimWorkspace();
    const { claim } = await checkoutClaim(ws, { expiresAt: T0 + 1000 });
    const consume = (workspaceId: string, id: string, now = NOW) =>
      consumeCheckoutClaim(db, { workspaceId, id, customerId: ws.customer.id, now });
    expect(await consume(ws.workspaceId, claim.id, T0 + 1000)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(await consume(ws.workspaceId, uniqueId("ckc"))).toEqual({
      ok: false,
      reason: "not_found",
    });
    const other = await claimWorkspace();
    expect(await consume(other.workspaceId, claim.id, T0 + 1)).toEqual({
      ok: false,
      reason: "not_found",
    });
    expect(
      (await getCheckoutClaim(db, { workspaceId: ws.workspaceId, id: claim.id }))?.consumedAt,
    ).toBeNull();
  });

  it("isolation/composite-fk-rejects-cross-tenant-link: cannot be consumed by another workspace's customer", async () => {
    const ws = await claimWorkspace();
    const other = await claimWorkspace();
    const { claim } = await checkoutClaim(ws);
    await expect(
      consumeCheckoutClaim(db, {
        workspaceId: ws.workspaceId,
        id: claim.id,
        customerId: other.customer.id,
        now: NOW,
      }),
    ).rejects.toThrow();
  });
});

describe("claim requests", () => {
  async function request(ws: Ws) {
    const id = uniqueId("clr");
    const outbox = outboxRow("send_claim_email", `${ws.workspaceId}:${id}`);
    const event = workspaceEvent(ws.workspaceId);
    const row = await createClaimRequest(
      db,
      {
        request: {
          id,
          workspaceId: ws.workspaceId,
          userId: ws.buyer,
          emailHash: hexDigest(),
          emailEnvelope: ENVELOPE,
          createdAt: T0,
        },
        outbox,
      },
      [event],
    );
    return { row, outbox, event };
  }

  it("are recorded with their audit event and send_claim_email outbox row in one batch", async () => {
    const ws = await claimWorkspace();
    const { row, outbox, event } = await request(ws);
    expect(row.processedAt).toBeNull();
    expect(await getClaimRequest(db, { workspaceId: ws.workspaceId, id: row.id })).toEqual(row);
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);
    expect(await count("outbox", "id = ? AND kind = 'send_claim_email'", outbox.id)).toBe(1);
  });

  it("write nothing when the row is invalid", async () => {
    const ws = await claimWorkspace();
    const outbox = outboxRow("send_claim_email", uniqueId("key"));
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      createClaimRequest(
        db,
        {
          request: {
            id: uniqueId("clr"),
            workspaceId: ws.workspaceId,
            userId: ws.buyer,
            emailHash: "not-hex",
            emailEnvelope: ENVELOPE,
            createdAt: T0,
          },
          outbox,
        },
        [event],
      ),
    ).rejects.toThrow();
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
    expect(await count("outbox", "id = ?", outbox.id)).toBe(0);
  });

  it("isolation/cross-workspace-read-denied: are read only in their workspace", async () => {
    const ws = await claimWorkspace();
    const other = await claimWorkspace();
    const { row } = await request(ws);
    expect(await getClaimRequest(db, { workspaceId: other.workspaceId, id: row.id })).toBeNull();
  });

  it("finish once, erasing the email and issuing tokens under the same guard", async () => {
    const ws = await claimWorkspace();
    const { row } = await request(ws);
    const key = { workspaceId: ws.workspaceId, id: row.id };
    const token = tokenRow(ws);
    const event = workspaceEvent(ws.workspaceId);
    expect(await finishClaimRequest(db, { ...key, now: NOW, tokens: [token] }, [event])).toEqual({
      ok: true,
    });
    expect(await getClaimRequest(db, key)).toMatchObject({ emailEnvelope: null, processedAt: NOW });
    expect(await findClaimTokenByHash(db, token.tokenHash)).toEqual({
      ...token,
      consumedAt: null,
      consumedByUserId: null,
    });
    expect(await auditCount(env.DB, event.correlationId)).toBe(1);

    const retry = tokenRow(ws);
    const again = workspaceEvent(ws.workspaceId);
    expect(
      await finishClaimRequest(db, { ...key, now: NOW + 1, tokens: [retry] }, [again]),
    ).toEqual({ ok: false, reason: "stale" });
    expect(await findClaimTokenByHash(db, retry.tokenHash)).toBeNull();
    expect(await auditCount(env.DB, again.correlationId)).toBe(0);
  });

  it("finish with no match: only the email is erased", async () => {
    const ws = await claimWorkspace();
    const { row } = await request(ws);
    expect(
      await finishClaimRequest(db, { workspaceId: ws.workspaceId, id: row.id, now: NOW }),
    ).toEqual({ ok: true });
    expect(await count("claim_requests", "id = ? AND email_envelope IS NULL", row.id)).toBe(1);
  });

  it("isolation/cross-workspace-read-denied: finish nothing in another workspace, and refuse foreign tokens", async () => {
    const ws = await claimWorkspace();
    const other = await claimWorkspace();
    const { row } = await request(ws);
    expect(
      await finishClaimRequest(db, { workspaceId: other.workspaceId, id: row.id, now: NOW }),
    ).toEqual({ ok: false, reason: "stale" });
    await expect(
      finishClaimRequest(db, {
        workspaceId: ws.workspaceId,
        id: row.id,
        now: NOW,
        tokens: [tokenRow(other)],
      }),
    ).rejects.toThrow("tokens must belong to the request's workspace");
    expect(await count("claim_requests", "id = ? AND email_envelope IS NOT NULL", row.id)).toBe(1);
  });
});

describe("claim tokens", () => {
  it("are issued with audit and found globally by hash", async () => {
    const ws = await claimWorkspace();
    const tokens = [tokenRow(ws), tokenRow(ws, { customerId: ws.otherCustomer.id })];
    const events = [workspaceEvent(ws.workspaceId), workspaceEvent(ws.workspaceId)] as const;
    const rows = await createClaimTokens(db, tokens, events);
    expect(rows.every((row) => row.consumedAt === null)).toBe(true);
    expect(await findClaimTokenByHash(db, tokens[1]?.tokenHash as string)).toMatchObject({
      workspaceId: ws.workspaceId,
      customerId: ws.otherCustomer.id,
    });
    expect(await findClaimTokenByHash(db, hexDigest())).toBeNull();
    for (const event of events) expect(await auditCount(env.DB, event.correlationId)).toBe(1);
  });

  it("isolation/composite-fk-rejects-cross-tenant-link: cannot name another workspace's customer", async () => {
    const ws = await claimWorkspace();
    const other = await claimWorkspace();
    const event = workspaceEvent(ws.workspaceId);
    await expect(
      createClaimTokens(db, [tokenRow(ws, { customerId: other.customer.id })], [event]),
    ).rejects.toThrow();
    expect(await auditCount(env.DB, event.correlationId)).toBe(0);
  });

  it("claim/token-single-use-and-expiring: are consumed once, before they expire", async () => {
    const ws = await claimWorkspace();
    const [token, expiring] = await createClaimTokens(
      db,
      [tokenRow(ws), tokenRow(ws, { expiresAt: T0 + 1000 })],
      [workspaceEvent(ws.workspaceId)],
    );
    const use = (id: string, now = NOW, workspaceId = ws.workspaceId) =>
      consumeClaimToken(db, { workspaceId, id, userId: ws.buyer, now }, [
        workspaceEvent(ws.workspaceId, { correlationId: `use-${id}-${now}` }),
      ]);
    const tokenId = token?.id as string;
    expect(await use(tokenId)).toEqual({ ok: true });
    expect(await auditCount(env.DB, `use-${tokenId}-${NOW}`)).toBe(1);
    expect(await use(tokenId, NOW + 1)).toEqual({ ok: false, reason: "already_used" });
    expect(await auditCount(env.DB, `use-${tokenId}-${NOW + 1}`)).toBe(0);
    expect(await findClaimTokenByHash(db, token?.tokenHash as string)).toMatchObject({
      consumedAt: NOW,
      consumedByUserId: ws.buyer,
    });
    const expiringId = expiring?.id as string;
    expect(await use(expiringId, T0 + 1000)).toEqual({ ok: false, reason: "expired" });
    expect(await use(uniqueId("clt"))).toEqual({ ok: false, reason: "not_found" });
  });

  it("isolation/cross-workspace-read-denied: are not consumed through another workspace", async () => {
    const ws = await claimWorkspace();
    const other = await claimWorkspace();
    const [token] = await createClaimTokens(db, [tokenRow(ws)], [workspaceEvent(ws.workspaceId)]);
    expect(
      await consumeClaimToken(db, {
        workspaceId: other.workspaceId,
        id: token?.id as string,
        userId: ws.buyer,
        now: NOW,
      }),
    ).toEqual({ ok: false, reason: "not_found" });
    expect(await count("claim_tokens", "id = ? AND consumed_at IS NULL", token?.id)).toBe(1);
  });
});

describe("hitRateLimits", () => {
  it("claim/request-rate-limited: counts per bucket within its window, then restarts", async () => {
    const email = `email:${hexDigest()}`;
    const user = `user:${uniqueId("usr")}`;
    const hour = 60 * 60_000;
    const buckets = [
      { bucket: `${email}:1h`, windowMs: hour },
      { bucket: `${email}:1d`, windowMs: 24 * hour },
      { bucket: user, windowMs: hour },
    ];
    expect(await hitRateLimits(db, buckets, T0)).toEqual([1, 1, 1]);
    expect(await hitRateLimits(db, buckets, T0 + 1)).toEqual([2, 2, 2]);
    expect(await hitRateLimits(db, buckets.slice(0, 2), T0 + hour - 1)).toEqual([3, 3]);
    // The hourly window has passed; the daily one has not.
    expect(await hitRateLimits(db, buckets, T0 + hour)).toEqual([1, 4, 1]);
    const row = await env.DB.prepare(
      "SELECT window_start, count FROM claim_rate_limits WHERE bucket = ?",
    )
      .bind(`${email}:1h`)
      .first();
    expect(row).toEqual({ window_start: T0 + hour, count: 1 });
  });

  it("does nothing for no buckets", async () => {
    expect(await hitRateLimits(db, [], T0)).toEqual([]);
  });
});
