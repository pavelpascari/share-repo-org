import { env } from "cloudflare:workers";
import { getPaddleConnection, markOutboxSent, type PaddleConnection } from "@sharerepo/db";
import type { PaddlePrice } from "@sharerepo/integrations";
import {
  createFakePaddle,
  type FakePaddle,
  type FakePaddleDelivery,
  type FakePaddleOptions,
} from "@sharerepo/integrations/testing";
import type { CredentialKeyring } from "@sharerepo/platform";
import {
  type CommerceDeps,
  connectPaddle,
  createOffer,
  decodeOfferKey,
  decodeRefreshKey,
  ingestPaddleWebhook,
  type OfferSummary,
  paddleEntitlementSource,
  processPaddleEvent,
  recomputeOffer,
  refreshSubscription,
  type ServiceContext,
  startCheckout,
  type UserActor,
} from "../../src/index.ts";
import { type Shop, shop, source as simulatedSource } from "./commerce.ts";
import { clock, db, serviceContext, signedUpUser } from "./context.ts";

const key = (seed: number) => new Uint8Array(32).fill(seed);

/** Fixed master keys (testing strategy: secrets come from fixed test keys). */
export const KEYRING: CredentialKeyring = { current: "k1", keys: { k1: key(1) } };
/** The same keyring after rotation: `k2` is current, `k1` still opens old envelopes. */
export const ROTATED: CredentialKeyring = { current: "k2", keys: { k1: key(1), k2: key(2) } };
export const CLAIM_KEY = new TextEncoder().encode("claim-signing-key-for-tests-0123456789");

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const random = (length: number, alphabet = ALNUM) =>
  [...crypto.getRandomValues(new Uint8Array(length))]
    .map((value) => alphabet[value % alphabet.length])
    .join("");

/** A fresh, well-formed Paddle API key (`pdl_sdbx_apikey_…` or `pdl_live_apikey_…`). */
export function apiKey(environment: "sdbx" | "live" = "sdbx"): string {
  return `pdl_${environment}_apikey_${random(26, "abcdefghijklmnopqrstuvwxyz0123456789")}_${random(22)}_${random(3)}`;
}

let sellers = Math.floor(Math.random() * 1e8);
/** A seller ID of Paddle's shape. */
export const sellerId = () => `slr_${String(++sellers).padStart(26, "0")}`;

/**
 * Paddle accounts by key: `deps.paddle` resolves a key to the fake seller it was issued for, as
 * Paddle would. An unknown key is refused like a revoked one.
 */
export class PaddleAccounts {
  readonly #byKey = new Map<string, FakePaddle>();

  /** A new seller account (a FakePaddle on the shared clock) and a key for it. */
  seller(options: FakePaddleOptions = {}): { fake: FakePaddle; key: string } {
    const fake = createFakePaddle({
      clock,
      seller: { id: sellerId(), name: "Acme Seller" },
      ...options,
    });
    return { fake, key: this.issue(fake) };
  }

  /** Another key for the same account. */
  issue(fake: FakePaddle, environment: "sdbx" | "live" = "sdbx"): string {
    const value = apiKey(environment);
    this.#byKey.set(value, fake);
    return value;
  }

  resolve(apiKey: string): FakePaddle {
    const fake = this.#byKey.get(apiKey);
    if (fake === undefined) throw new Error("test: unknown Paddle key");
    return fake;
  }
}

export function commerceDeps(
  accounts: PaddleAccounts,
  overrides: Partial<CommerceDeps> = {},
): CommerceDeps {
  return {
    paddle: ({ apiKey }) => accounts.resolve(apiKey),
    credentialKeys: KEYRING,
    claimSigningKey: CLAIM_KEY,
    baseUrl: "https://sharerepo.test/",
    deployment: "development",
    ...overrides,
  };
}

/** A creator's workspace with GitHub and Paddle connected, a price and an offer selling it. */
export interface PaddleShop extends Shop {
  readonly accounts: PaddleAccounts;
  readonly deps: CommerceDeps;
  readonly paddle: FakePaddle;
  readonly key: string;
  readonly connectionId: string;
  readonly price: PaddlePrice;
  readonly offer: OfferSummary;
}

export async function paddleShop(
  options: { gracePeriodDays?: number; deps?: Partial<CommerceDeps> } = {},
): Promise<PaddleShop> {
  const s = await shop();
  const accounts = new PaddleAccounts();
  const { fake, key: value } = accounts.seller();
  const price = fake.addPrice();
  const deps = commerceDeps(accounts, options.deps);
  const connected = await connectPaddle(
    serviceContext(),
    s,
    s.slug,
    { apiKey: value, apiKeyExpiresOn: clock.now() + 300 * 86_400_000 },
    deps,
  );
  if (!connected.ok) throw new Error(JSON.stringify(connected.error));
  const created = await createOffer(serviceContext(), s, s.slug, {
    name: "Pro",
    gracePeriodDays: options.gracePeriodDays ?? 7,
    items: [{ source: "paddle", externalItemId: price.id }],
    accesses: s.resources.map((resource) => ({ resourceId: resource.id, accessLevel: "write" })),
  });
  if (!created.ok) throw new Error(JSON.stringify(created.errors));
  return {
    ...s,
    accounts,
    deps,
    paddle: fake,
    key: value,
    connectionId: connected.connectionId,
    price,
    offer: created.offer,
  };
}

export async function connectionOf(s: PaddleShop): Promise<PaddleConnection> {
  return (await getPaddleConnection(db, { workspaceId: s.workspaceId })) as PaddleConnection;
}

/** The fake's destination for the shop's connection. */
export async function settingOf(s: PaddleShop): Promise<string> {
  return (await connectionOf(s)).destinationId as string;
}

/** Posts a delivery to the shop's webhook route, as Paddle would. */
export function post(
  s: PaddleShop,
  delivery: FakePaddleDelivery,
  ctx: ServiceContext = serviceContext(),
) {
  return ingestPaddleWebhook(
    ctx,
    {
      connectionId: s.connectionId,
      rawBody: new TextEncoder().encode(delivery.rawBody).buffer as ArrayBuffer,
      signatureHeader: delivery.signature,
    },
    s.deps,
  );
}

interface PendingRow {
  id: string;
  kind: string;
  subject_id: string;
}

/** Unsent rows of the workspace's entitlement work and of every processing intent. */
async function pending(workspaceId: string): Promise<PendingRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, kind, subject_id FROM outbox
     WHERE sent_at IS NULL AND failed_at IS NULL AND (
       (kind IN ('refresh_subscription', 'recompute_offer')
         AND substr(subject_id, 1, length(?1) + 1) = ?1 || ':')
       OR (kind = 'process_external_event' AND subject_id IN (
         SELECT e.id FROM external_events e JOIN paddle_connections c ON c.id = e.connection_id
         WHERE c.workspace_id = ?1)))
     ORDER BY created_at, id`,
  )
    .bind(workspaceId)
    .all<PendingRow>();
  return results;
}

/**
 * Runs the workspace's pending processing, refreshes (Paddle or simulated) and recomputes until
 * none is left, as the jobs Worker will. Returns how many rows ran.
 */
export async function drainPaddle(s: PaddleShop): Promise<number> {
  let ran = 0;
  for (let rows = await pending(s.workspaceId); rows.length > 0; ) {
    for (const row of rows) {
      const ctx = serviceContext();
      if (row.kind === "process_external_event") {
        await processPaddleEvent(ctx, row.subject_id);
      } else if (row.kind === "recompute_offer") {
        const offerKey = decodeOfferKey(row.subject_id);
        if (!offerKey.ok) throw new Error("bad offer key");
        await recomputeOffer(ctx, offerKey.value);
      } else {
        const refreshKey = decodeRefreshKey(row.subject_id);
        if (!refreshKey.ok) throw new Error("bad refresh key");
        const port =
          refreshKey.value.source === "paddle"
            ? paddleEntitlementSource(ctx, s.deps)
            : simulatedSource;
        await refreshSubscription(ctx, refreshKey.value, port);
      }
      await markOutboxSent(db, [row.id], clock.now());
      ran += 1;
    }
    rows = await pending(s.workspaceId);
  }
  return ran;
}

/** Delivers a subscription event for the subscription as it is now, then drains. */
export async function deliverSubscription(
  s: PaddleShop,
  eventType: string,
  subscriptionId: string,
): Promise<void> {
  const delivery = await s.paddle.emitSubscriptionEvent(
    await settingOf(s),
    eventType,
    subscriptionId,
  );
  const result = await post(s, delivery);
  if (result.status !== "accepted" && result.status !== "duplicate") {
    throw new Error(`delivery not accepted: ${result.status}`);
  }
  await drainPaddle(s);
}

let customers = Math.floor(Math.random() * 1e8);
/** A new Paddle customer of the shop's seller, with a unique email. */
export function paddleCustomer(s: PaddleShop, email = `buyer-${++customers}@example.com`) {
  return s.paddle.addCustomer({ id: `ctm_${String(++customers).padStart(26, "0")}`, email });
}

/** A subscription bought outside a ShareRepo checkout (a shared Paddle link): no reference. */
export function directSubscription(s: PaddleShop, customerId: string) {
  return s.paddle.createSubscription({ customerId, priceIds: [s.price.id] });
}

/** A client IP of a buyer's own, so tests never share an IP rate-limit bucket. */
export const buyerIp = () =>
  `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}`;

/** A signed-up buyer, with the GitHub identity sign-in gives them. */
export const buyer = () => signedUpUser();

/** The workspace's live entitlements for one GitHub account. */
export async function liveFor(workspaceId: string, externalSubjectId: string) {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.resource_id FROM entitlements e JOIN subjects s
       ON s.workspace_id = e.workspace_id AND s.id = e.subject_id
     WHERE e.workspace_id = ? AND s.external_subject_id = ? AND e.state = 'active'`,
  )
    .bind(workspaceId, externalSubjectId)
    .all<{ id: string; resource_id: string }>();
  return results;
}

/** Audit events of the workspace with this action, oldest first. */
export async function auditOf(workspaceId: string, action: string) {
  const { results } = await env.DB.prepare(
    `SELECT actor_type, actor_id, target_id, reason, details FROM audit_events
     WHERE workspace_id = ? AND action = ? ORDER BY occurred_at, rowid`,
  )
    .bind(workspaceId, action)
    .all<{
      actor_type: string;
      actor_id: string | null;
      target_id: string;
      reason: string | null;
      details: string;
    }>();
  return results.map((row) => ({ ...row, details: JSON.parse(row.details) }));
}

/**
 * Every place a secret must never reach: audit details and reasons, external event metadata,
 * outbox rows and stored claim rows other than their envelopes and hashes.
 */
export async function storedText(): Promise<string> {
  const tables = [
    "SELECT action, reason, details FROM audit_events",
    "SELECT * FROM external_events",
    "SELECT * FROM outbox",
    "SELECT id, workspace_id, user_id, offer_id, price_id, transaction_id FROM checkout_claims",
    "SELECT id, workspace_id, user_id, email_hash FROM claim_requests",
    "SELECT * FROM claim_rate_limits",
    "SELECT id, workspace_id, seller_id, seller_name, destination_id, status, status_reason FROM paddle_connections",
  ];
  const parts = await Promise.all(
    tables.map(async (query) => JSON.stringify((await env.DB.prepare(query).all()).results)),
  );
  return parts.join("\n");
}

/**
 * A service context whose first database batch runs `interfere` first, as a concurrent writer
 * that commits between the service's reads and its write would.
 */
export function beforeFirstBatch(interfere: () => Promise<unknown>): ServiceContext {
  let armed = true;
  const contended = new Proxy(db, {
    get: (target, property, receiver) => {
      if (property !== "batch") return Reflect.get(target, property, receiver);
      return async (...args: Parameters<typeof target.batch>) => {
        if (armed) {
          armed = false;
          await interfere();
        }
        return target.batch(...args);
      };
    },
  });
  return { ...serviceContext(), db: contended };
}

/**
 * A signed-in buyer checks out from ShareRepo (path 1) and pays as a new Paddle customer; the
 * signed `subscription.created` webhook is delivered and every resulting job drained.
 */
export async function purchase(s: PaddleShop, user: UserActor) {
  const started = await startCheckout(
    serviceContext(),
    { offerId: s.offer.id, priceId: s.price.id, user, ip: buyerIp() },
    s.deps,
  );
  if (!started.ok) throw new Error(started.reason);
  const transactionId = new URL(started.checkoutUrl).searchParams.get("_ptxn") as string;
  const customer = paddleCustomer(s);
  const subscription = s.paddle.completeCheckout(transactionId, { customerId: customer.id });
  await deliverSubscription(s, "subscription.created", subscription.id);
  return { customer, subscription, checkoutClaimId: started.checkoutClaimId, transactionId };
}
