import { env } from "cloudflare:workers";
import {
  type CommerceDeps,
  connectPaddle,
  createOffer,
  decodeClaimRequestKey,
  decodeOfferKey,
  decodeRefreshKey,
  ingestPaddleWebhook,
  type OfferSummary,
  paddleEntitlementSource,
  processPaddleEvent,
  recomputeOffer,
  refreshSubscription,
  requestClaim,
  sendClaimEmail,
  type UserActor,
} from "@sharerepo/application";
import { getPaddleConnection, markOutboxSent } from "@sharerepo/db";
import type { PaddlePrice } from "@sharerepo/integrations";
import {
  createFakeMail,
  createFakePaddle,
  type FakePaddle,
  type FakePaddleOptions,
} from "@sharerepo/integrations/testing";
import { commerceDepsFromEnv, providerOverrides } from "../../app/commerce.server.ts";
import { parseWebEnv } from "../../workers/env.ts";
import { harness, type Shop, type SignedIn, services, shop } from "./shop.ts";
import { db } from "./sign-in.ts";

// A creator's workspace with GitHub and Paddle connected (against FakePaddle), built through the
// real services with the test Worker's own keyring, so the webhook entry point can open the
// secrets it sealed.

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const random = (length: number, alphabet = ALNUM) =>
  [...crypto.getRandomValues(new Uint8Array(length))]
    .map((value) => alphabet[value % alphabet.length])
    .join("");

/** A fresh, well-formed sandbox API key. */
export function apiKey(): string {
  return `pdl_sdbx_apikey_${random(26, "abcdefghijklmnopqrstuvwxyz0123456789")}_${random(22)}_${random(3)}`;
}

let sellers = Math.floor(Math.random() * 1e8);

/** Paddle accounts by key, as Paddle resolves them. An unknown key is refused. */
export class PaddleAccounts {
  readonly #byKey = new Map<string, FakePaddle>();

  seller(options: FakePaddleOptions = {}): { fake: FakePaddle; key: string } {
    const fake = createFakePaddle({
      seller: { id: `slr_${String(++sellers).padStart(26, "0")}`, name: "Acme Seller" },
      ...options,
    });
    return { fake, key: this.issue(fake) };
  }

  issue(fake: FakePaddle): string {
    const value = apiKey();
    this.#byKey.set(value, fake);
    return value;
  }

  readonly factory: CommerceDeps["paddle"] = ({ apiKey: key }) => {
    const fake = this.#byKey.get(key);
    if (fake === undefined) throw new Error("test: unknown Paddle key");
    return fake;
  };
}

/** The commerce dependencies the web Worker builds, with the accounts' fakes as Paddle. */
export function deps(accounts: PaddleAccounts): CommerceDeps {
  return commerceDepsFromEnv(parseWebEnv(env), accounts.factory) as CommerceDeps;
}

/** A route harness whose Paddle is the accounts' fakes (and optionally a mail transport). */
export function paddleHarness(
  accounts: PaddleAccounts,
  options: Parameters<typeof harness>[0] & { github?: Shop["github"] } = {},
) {
  const h = harness(options);
  h.context.set(providerOverrides, {
    paddle: accounts.factory,
    ...(options.github === undefined ? {} : { github: options.github }),
  });
  return h;
}

export interface PaddleShop extends Shop {
  readonly accounts: PaddleAccounts;
  readonly deps: CommerceDeps;
  readonly paddle: FakePaddle;
  readonly key: string;
  readonly connectionId: string;
  readonly price: PaddlePrice;
  readonly offer: OfferSummary;
}

/** Connects Paddle to an existing shop. */
export async function connect(s: Shop, accounts = new PaddleAccounts()) {
  const { fake, key } = accounts.seller();
  const price = fake.addPrice();
  const d = deps(accounts);
  const connected = await connectPaddle(
    services(),
    s.owner,
    s.slug,
    { apiKey: key, apiKeyExpiresOn: Date.now() + 300 * 86_400_000 },
    d,
  );
  if (!connected.ok) throw new Error(JSON.stringify(connected.error));
  return { accounts, deps: d, paddle: fake, key, connectionId: connected.connectionId, price };
}

export async function paddleShop(): Promise<PaddleShop> {
  const s = await shop();
  const connected = await connect(s);
  const created = await createOffer(services(), s.owner, s.slug, {
    name: "Pro",
    gracePeriodDays: 7,
    items: [{ source: "paddle", externalItemId: connected.price.id }],
    accesses: s.resources
      .filter((resource) => resource.private)
      .map((resource) => ({ resourceId: resource.id, accessLevel: "write" })),
  });
  if (!created.ok) throw new Error(JSON.stringify(created.errors));
  return { ...s, ...connected, offer: created.offer };
}

export async function settingOf(s: PaddleShop): Promise<string> {
  const connection = await getPaddleConnection(db, { workspaceId: s.workspaceId });
  return connection?.destinationId as string;
}

interface PendingRow {
  id: string;
  kind: string;
  subject_id: string;
}

/** Runs the workspace's pending processing, refreshes and recomputes, as the jobs Worker will. */
export async function drain(s: PaddleShop): Promise<void> {
  const pending = async () =>
    (
      await env.DB.prepare(
        `SELECT id, kind, subject_id FROM outbox
         WHERE sent_at IS NULL AND failed_at IS NULL AND (
           (kind IN ('refresh_subscription', 'recompute_offer')
             AND substr(subject_id, 1, length(?1) + 1) = ?1 || ':')
           OR (kind = 'process_external_event' AND subject_id IN (
             SELECT e.id FROM external_events e JOIN paddle_connections c
               ON c.id = e.connection_id WHERE c.workspace_id = ?1)))
         ORDER BY created_at, id`,
      )
        .bind(s.workspaceId)
        .all<PendingRow>()
    ).results;
  for (let rows = await pending(); rows.length > 0; rows = await pending()) {
    for (const row of rows) {
      const ctx = services();
      if (row.kind === "process_external_event") {
        await processPaddleEvent(ctx, row.subject_id);
      } else if (row.kind === "recompute_offer") {
        const key = decodeOfferKey(row.subject_id);
        if (!key.ok) throw new Error("bad offer key");
        await recomputeOffer(ctx, key.value);
      } else {
        const key = decodeRefreshKey(row.subject_id);
        if (!key.ok) throw new Error("bad refresh key");
        await refreshSubscription(ctx, key.value, paddleEntitlementSource(ctx, s.deps));
      }
      await markOutboxSent(db, [row.id], Date.now());
    }
  }
}

/** Posts a delivery to the service as Paddle would, then drains. */
async function deliver(s: PaddleShop, rawBody: string, signature: string) {
  const result = await ingestPaddleWebhook(
    services(),
    {
      connectionId: s.connectionId,
      rawBody: new TextEncoder().encode(rawBody).buffer as ArrayBuffer,
      signatureHeader: signature,
    },
    s.deps,
  );
  if (result.status !== "accepted") throw new Error(result.status);
  await drain(s);
}

let customers = Math.floor(Math.random() * 1e8);

/** A paid subscription bought through a shared Paddle link: known to ShareRepo, unclaimed. */
export async function unclaimedPurchase(s: PaddleShop) {
  const customer = s.paddle.addCustomer({
    id: `ctm_${String(++customers).padStart(26, "0")}`,
    email: `buyer-${customers}@example.com`,
  });
  const subscription = s.paddle.createSubscription({
    customerId: customer.id,
    priceIds: [s.price.id],
  });
  const delivery = await s.paddle.emitSubscriptionEvent(
    await settingOf(s),
    "subscription.created",
    subscription.id,
  );
  await deliver(s, delivery.rawBody, delivery.signature);
  return { customer, subscription };
}

/** Requests a claim for the email and runs the job: the emailed link's token. */
export async function claimToken(s: PaddleShop, user: UserActor, email: string): Promise<string> {
  const requested = await requestClaim(
    services(),
    { workspaceSlug: s.slug, email, user, ip: `198.51.100.${Math.floor(Math.random() * 250)}` },
    s.deps,
  );
  if (requested.status !== "requested" || requested.outboxId === null) throw new Error("limited");
  const row = await env.DB.prepare("SELECT subject_id FROM outbox WHERE id = ?")
    .bind(requested.outboxId)
    .first<{ subject_id: string }>();
  const ref = decodeClaimRequestKey(row?.subject_id as string);
  if (!ref.ok) throw new Error("bad claim request key");
  const mail = createFakeMail();
  await sendClaimEmail(services(), ref.value, { ...s.deps, mail });
  const token = mail.sent[0]?.text.match(/\/claim\/([A-Za-z0-9_-]+)/)?.[1];
  if (token === undefined) throw new Error("no claim email");
  return token;
}

/**
 * Every row a claim page could write for this workspace and user, as stored: audit events,
 * outbox rows, claim tokens and requests, the user's rate-limit bucket, customers and their links,
 * subjects, entitlements and the user's sessions.
 */
export async function claimState(workspaceId: string, userId: string): Promise<unknown> {
  const queries: [string, ...string[]][] = [
    ["SELECT * FROM audit_events WHERE workspace_id = ? ORDER BY id", workspaceId],
    ["SELECT * FROM audit_events WHERE actor_id = ? ORDER BY id", userId],
    ["SELECT * FROM outbox WHERE substr(subject_id, 1, length(?1)) = ?1 ORDER BY id", workspaceId],
    ["SELECT * FROM claim_tokens WHERE workspace_id = ? ORDER BY id", workspaceId],
    ["SELECT * FROM claim_requests WHERE workspace_id = ? ORDER BY id", workspaceId],
    [
      "SELECT * FROM claim_rate_limits WHERE substr(bucket, 1, length(?1)) = ?1 ORDER BY bucket",
      `user:${userId}:`,
    ],
    ["SELECT * FROM customers WHERE workspace_id = ? ORDER BY id", workspaceId],
    ["SELECT * FROM subjects WHERE workspace_id = ? ORDER BY id", workspaceId],
    ["SELECT * FROM entitlements WHERE workspace_id = ? ORDER BY id", workspaceId],
    ["SELECT * FROM auth_sessions WHERE user_id = ? ORDER BY id", userId],
  ];
  const results = [];
  for (const [sql, ...params] of queries) {
    results.push(
      (
        await env.DB.prepare(sql)
          .bind(...params)
          .all()
      ).results,
    );
  }
  return results;
}

export type { SignedIn };
