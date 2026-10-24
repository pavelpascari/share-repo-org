import { env } from "cloudflare:workers";
import { type RateLimitBucket, type RateLimitCounter, rateLimitDecision } from "@sharerepo/domain";
import { describe, expect, it } from "vitest";
import {
  consumeCheckoutClaim,
  consumeClaimToken,
  createCheckoutClaim,
  createClaimRequest,
  createClaimTokens,
  findClaimTokenByHash,
  findReusableCheckoutClaim,
  finishClaimRequest,
  getCheckoutClaim,
  getClaimRequest,
  type NewClaimToken,
  schema,
  setCheckoutClaimTransaction,
  takeRateLimits,
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

async function checkoutClaim(
  ws: Ws,
  overrides: { expiresAt?: number; createdAt?: number; priceId?: string; userId?: string } = {},
) {
  const event = workspaceEvent(ws.workspaceId);
  const createdAt = overrides.createdAt ?? T0;
  const claim = await createCheckoutClaim(
    db,
    {
      id: uniqueId("ckc"),
      workspaceId: ws.workspaceId,
      userId: overrides.userId ?? ws.buyer,
      offerId: ws.offerId,
      priceId: overrides.priceId ?? "pri_01",
      createdAt,
      expiresAt: overrides.expiresAt ?? createdAt + 7 * DAY,
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
      checkoutUrl: null,
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
    expect(await getCheckoutClaim(db, key)).toMatchObject({
      transactionId: "txn_1",
      checkoutUrl: null,
    });
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

  it("record the checkout URL with their transaction", async () => {
    const ws = await claimWorkspace();
    const { claim } = await checkoutClaim(ws);
    const key = { workspaceId: ws.workspaceId, id: claim.id };
    const checkoutUrl = "https://seller.example/pay?_ptxn=txn_1";
    expect(
      await setCheckoutClaimTransaction(db, { ...key, transactionId: "txn_1", checkoutUrl }),
    ).toEqual({ ok: true });
    expect(await getCheckoutClaim(db, key)).toMatchObject({ transactionId: "txn_1", checkoutUrl });
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

describe("findReusableCheckoutClaim", () => {
  async function started(ws: Ws, overrides: Parameters<typeof checkoutClaim>[1] = {}) {
    const { claim } = await checkoutClaim(ws, overrides);
    const transactionId = `txn_${uniqueId("t")}`;
    const checkoutUrl = `https://seller.example/pay?_ptxn=${transactionId}`;
    await setCheckoutClaimTransaction(db, {
      workspaceId: ws.workspaceId,
      id: claim.id,
      transactionId,
      checkoutUrl,
    });
    return { ...claim, transactionId, checkoutUrl };
  }

  const find = (ws: Ws, overrides: { createdAfter?: number; priceId?: string } = {}) =>
    findReusableCheckoutClaim(db, {
      workspaceId: ws.workspaceId,
      userId: ws.buyer,
      offerId: ws.offerId,
      priceId: overrides.priceId ?? "pri_01",
      createdAfter: overrides.createdAfter ?? T0 - 1,
      now: NOW,
    });

  it("finds the newest open checkout of the same user, offer and price after a time", async () => {
    const ws = await claimWorkspace();
    expect(await find(ws)).toBeNull();
    // Without a checkout URL there is nothing to send the buyer back to.
    await checkoutClaim(ws, { createdAt: T0 + 2 });
    expect(await find(ws)).toBeNull();
    const older = await started(ws, { createdAt: T0 });
    const newer = await started(ws, { createdAt: T0 + 1 });
    expect(await find(ws)).toEqual(newer);
    expect(await find(ws, { createdAfter: T0 + 1 })).toBeNull();
    expect(await find(ws, { createdAfter: T0 })).toEqual(newer);
    expect(older.checkoutUrl).not.toBe(newer.checkoutUrl);
  });

  it("skips consumed and expired claims, and other prices, users and workspaces", async () => {
    const ws = await claimWorkspace();
    const consumed = await started(ws);
    await consumeCheckoutClaim(db, {
      workspaceId: ws.workspaceId,
      id: consumed.id,
      customerId: ws.customer.id,
      now: NOW,
    });
    expect(await find(ws)).toBeNull();
    await started(ws, { expiresAt: NOW });
    expect(await find(ws)).toBeNull();
    const open = await started(ws, { expiresAt: NOW + 1 });
    expect(await find(ws)).toEqual(open);
    expect(await find(ws, { priceId: "pri_02" })).toBeNull();
    const someoneElse = uniqueId("usr");
    await insertUserRow(someoneElse);
    expect(
      await findReusableCheckoutClaim(db, {
        workspaceId: ws.workspaceId,
        userId: someoneElse,
        offerId: ws.offerId,
        priceId: "pri_01",
        createdAfter: T0 - 1,
        now: NOW,
      }),
    ).toBeNull();
    const other = await claimWorkspace();
    expect(
      await findReusableCheckoutClaim(db, {
        workspaceId: other.workspaceId,
        userId: ws.buyer,
        offerId: ws.offerId,
        priceId: "pri_01",
        createdAfter: T0 - 1,
        now: NOW,
      }),
    ).toBeNull();
  });
});

describe("takeRateLimits", () => {
  const HOUR = 60 * 60_000;
  const bucketsOf = (...limits: [number, number][]): RateLimitBucket[] => {
    const prefix = uniqueId("rl");
    return limits.map(([windowMs, limit], i) => ({ bucket: `${prefix}:${i}`, windowMs, limit }));
  };

  async function stored(buckets: readonly RateLimitBucket[]): Promise<RateLimitCounter[]> {
    const rows: RateLimitCounter[] = [];
    for (const { bucket } of buckets) {
      const row = await env.DB.prepare(
        "SELECT bucket, window_start AS windowStart, count FROM claim_rate_limits WHERE bucket = ?",
      )
        .bind(bucket)
        .first<RateLimitCounter>();
      if (row !== null) rows.push(row);
    }
    return rows;
  }

  const counts = async (buckets: readonly RateLimitBucket[]) =>
    (await stored(buckets)).map((c) => c.count);

  it("claim/request-rate-limited: counts a request in every bucket, or in none", async () => {
    const buckets = bucketsOf([HOUR, 3], [HOUR, 1], [24 * HOUR, 10]);
    expect(await takeRateLimits(db, buckets, T0)).toBe(true);
    expect(await counts(buckets)).toEqual([1, 1, 1]);
    // The second bucket is exhausted: the request is refused and counts against no bucket.
    for (let i = 0; i < 3; i += 1) {
      expect(await takeRateLimits(db, buckets, T0 + i)).toBe(false);
    }
    expect(await counts(buckets)).toEqual([1, 1, 1]);
    // Its window ends: allowed again, counted everywhere.
    expect(await takeRateLimits(db, buckets, T0 + HOUR)).toBe(true);
    expect(await stored(buckets)).toEqual([
      { bucket: buckets[0]?.bucket, windowStart: T0 + HOUR, count: 1 },
      { bucket: buckets[1]?.bucket, windowStart: T0 + HOUR, count: 1 },
      { bucket: buckets[2]?.bucket, windowStart: T0, count: 2 },
    ]);
  });

  it("allows the request that brings every bucket to its limit at once", async () => {
    const buckets = bucketsOf([HOUR, 2], [HOUR, 2], [HOUR, 2]);
    expect(await takeRateLimits(db, buckets, T0)).toBe(true);
    expect(await takeRateLimits(db, buckets, T0)).toBe(true);
    expect(await counts(buckets)).toEqual([2, 2, 2]);
    expect(await takeRateLimits(db, buckets, T0)).toBe(false);
    expect(await counts(buckets)).toEqual([2, 2, 2]);
  });

  it("refuses when only the last bucket is exhausted, leaving the others untouched", async () => {
    const [a, b] = bucketsOf([HOUR, 5], [HOUR, 1]) as [RateLimitBucket, RateLimitBucket];
    expect(await takeRateLimits(db, [b], T0)).toBe(true);
    expect(await takeRateLimits(db, [a, b], T0)).toBe(false);
    expect(await stored([a, b])).toEqual([{ bucket: b.bucket, windowStart: T0, count: 1 }]);
  });

  it("restarts a counter stored for an earlier, or unaligned, window", async () => {
    const [bucket] = bucketsOf([HOUR, 1]) as [RateLimitBucket];
    await env.DB.prepare(
      "INSERT INTO claim_rate_limits (bucket, window_start, count) VALUES (?, ?, ?)",
    )
      .bind(bucket.bucket, T0 + 17, 9)
      .run();
    expect(await takeRateLimits(db, [bucket], T0 + HOUR)).toBe(true);
    expect(await stored([bucket])).toEqual([
      { bucket: bucket.bucket, windowStart: T0 + HOUR, count: 1 },
    ]);
  });

  it("agrees with the domain's rateLimitDecision over a sequence of requests", async () => {
    const buckets = bucketsOf([HOUR, 2], [3 * HOUR, 4], [60_000, 1]);
    const subsets = [[0, 1, 2], [0, 1], [1, 2], [0], [2], [0, 2]];
    for (let step = 0; step < 60; step += 1) {
      const now = T0 + step * 7 * 60_000;
      const asked = (subsets[step % subsets.length] as number[]).map(
        (i) => buckets[i] as RateLimitBucket,
      );
      const before = await stored(asked);
      const expected = rateLimitDecision(asked, before, now);
      expect(await takeRateLimits(db, asked, now)).toBe(expected.allowed);
      const after = await stored(asked);
      expect(after).toEqual(expected.allowed ? expected.counters : before);
    }
  });

  it("allows a request with no buckets", async () => {
    expect(await takeRateLimits(db, [], T0)).toBe(true);
  });
});
