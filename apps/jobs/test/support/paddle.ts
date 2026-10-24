import { env } from "cloudflare:workers";
import {
  type CommerceDeps,
  connectPaddle,
  createOffer,
  createUserForSignIn,
  encodeClaimRequestKey,
  ingestPaddleWebhook,
  recordSignIn,
  requestClaim,
  type UserActor,
} from "@sharerepo/application";
import {
  getPaddleConnection,
  listResourcesForConnection,
  markOutboxSent,
  type PaddleConnection,
} from "@sharerepo/db";
import { type GitHubUserId, parseGitHubLogin } from "@sharerepo/domain";
import type { PaddlePrice } from "@sharerepo/integrations";
import {
  createFakeGitHubApp,
  createFakeMail,
  createFakePaddle,
  type FakeMail,
  type FakePaddle,
  type FakePaddleDelivery,
} from "@sharerepo/integrations/testing";
import { parseCommerceSecrets } from "@sharerepo/platform";
import { type Shop, shop } from "./commerce.ts";
import { clock, db, envWithGitHub, serviceContext } from "./github.ts";
import { jobsWorker } from "./worker.ts";

// The commerce secrets the test Worker is configured with (vitest.config.ts), so what the tests
// seal the Worker can open.
const secrets = (() => {
  const parsed = parseCommerceSecrets(env);
  if (parsed === null) throw new Error("test: commerce secrets are not configured");
  return parsed;
})();

let counter = Math.floor(Math.random() * 1e8);
const unique = () => String(++counter);
const random = (length: number) =>
  [...crypto.getRandomValues(new Uint8Array(length))]
    .map((value) => "abcdefghijklmnopqrstuvwxyz0123456789"[value % 36])
    .join("");

/** A fresh, well-formed sandbox Paddle API key. */
const apiKey = () => `pdl_sdbx_apikey_${random(26)}_${random(22)}_${random(3)}`;

/** Paddle accounts by key: a key resolves to the fake seller it was issued for, as in Paddle. */
export class PaddleAccounts {
  readonly #byKey = new Map<string, FakePaddle>();

  seller(): { fake: FakePaddle; key: string } {
    const fake = createFakePaddle({
      clock,
      seller: { id: `slr_${unique().padStart(26, "0")}`, name: "Acme Seller" },
    });
    const key = apiKey();
    this.#byKey.set(key, fake);
    return { fake, key };
  }

  resolve(key: string): FakePaddle {
    const fake = this.#byKey.get(key);
    if (fake === undefined) throw new Error("test: unknown Paddle key");
    return fake;
  }
}

/** The commerce dependencies the test Worker builds from its env, over the given accounts. */
export function commerceDeps(accounts: PaddleAccounts): CommerceDeps {
  return {
    paddle: ({ apiKey: key }) => accounts.resolve(key),
    credentialKeys: secrets.credentialKeys,
    claimSigningKey: secrets.claimSigningKey,
    baseUrl: env.PUBLIC_BASE_URL,
    deployment: "development",
  };
}

export interface PaddleShop extends Shop {
  readonly accounts: PaddleAccounts;
  readonly deps: CommerceDeps;
  readonly paddle: FakePaddle;
  readonly key: string;
  readonly connectionId: string;
  readonly price: PaddlePrice;
  readonly mail: FakeMail;
}

/**
 * A creator's workspace with GitHub and Paddle connected and an offer selling a Paddle price. The
 * offer's recompute is done, so it leaves no due outbox work behind.
 */
export async function paddleShop(): Promise<PaddleShop> {
  const s = await shop(createFakeGitHubApp());
  const accounts = new PaddleAccounts();
  const { fake, key } = accounts.seller();
  const price = fake.addPrice();
  const deps = commerceDeps(accounts);
  const connected = await connectPaddle(
    serviceContext(),
    s,
    s.slug,
    { apiKey: key, apiKeyExpiresOn: clock.now() + 300 * 86_400_000 },
    deps,
  );
  if (!connected.ok) throw new Error(JSON.stringify(connected.error));
  const created = await createOffer(serviceContext(), s, s.slug, {
    name: "Paddle Pro",
    gracePeriodDays: 7,
    items: [{ source: "paddle", externalItemId: price.id }],
    accesses: (
      await listResourcesForConnection(db, {
        workspaceId: s.workspaceId,
        connectionId: s.connection.id,
      })
    ).map((resource) => ({ resourceId: resource.id, accessLevel: "write" as const })),
  });
  if (!created.ok) throw new Error(JSON.stringify(created.errors));
  if (created.outboxId !== null) await markOutboxSent(db, [created.outboxId], clock.now());
  return {
    ...s,
    accounts,
    deps,
    paddle: fake,
    key,
    connectionId: connected.connectionId,
    price,
    mail: createFakeMail(),
  };
}

/** The jobs Worker with the shop's Paddle accounts and mailbox. */
export const paddleWorker = (s: PaddleShop) =>
  jobsWorker(s.github, {
    paddle: ({ apiKey: key }) => s.accounts.resolve(key),
    mail: () => s.mail,
  });

/** The test env with a mail transport: any object with `send` passes as the `EMAIL` binding. */
export const envWithMail = {
  ...envWithGitHub,
  EMAIL: { send: () => Promise.resolve({ messageId: "unused" }) },
} as Env;

export async function connectionOf(s: PaddleShop): Promise<PaddleConnection> {
  return (await getPaddleConnection(db, { workspaceId: s.workspaceId })) as PaddleConnection;
}

/** Records a signed delivery as the webhook route would; returns its event and outbox IDs. */
export async function received(s: PaddleShop, delivery: FakePaddleDelivery) {
  const result = await ingestPaddleWebhook(
    serviceContext(),
    {
      connectionId: s.connectionId,
      rawBody: new TextEncoder().encode(delivery.rawBody).buffer as ArrayBuffer,
      signatureHeader: delivery.signature,
    },
    s.deps,
  );
  if (result.status !== "accepted") throw new Error(`delivery not accepted: ${result.status}`);
  return { eventId: result.eventId, outboxId: result.outboxId };
}

/** A subscription bought through a shared Paddle link by a new customer with this email. */
export function directPurchase(s: PaddleShop, email = `buyer-${unique()}@example.com`) {
  const customer = s.paddle.addCustomer({ id: `ctm_${unique().padStart(26, "0")}`, email });
  const subscription = s.paddle.createSubscription({
    customerId: customer.id,
    priceIds: [s.price.id],
  });
  return { customer, subscription };
}

/** A user who signed in with GitHub. */
export async function signedUp(): Promise<UserActor> {
  const { userId } = await createUserForSignIn(serviceContext());
  const id = unique();
  const login = parseGitHubLogin(`buyer-${id}`);
  if (!login.ok) throw new Error(login.error);
  await recordSignIn(
    serviceContext(),
    { userId },
    {
      provider: "github",
      externalUserId: id as GitHubUserId,
      username: login.value,
      displayName: null,
      avatarUrl: null,
    },
  );
  return { userId };
}

/** A signed-in buyer asks for claim links; returns the job's subject and outbox row. */
export async function claimRequested(s: PaddleShop, email: string) {
  const requested = await requestClaim(
    serviceContext(),
    { workspaceSlug: s.slug, email, user: await signedUp(), ip: "203.0.113.7" },
    s.deps,
  );
  if (requested.status !== "requested" || requested.outboxId === null) {
    throw new Error("claim request not queued");
  }
  const row = await env.DB.prepare("SELECT subject_id FROM outbox WHERE id = ?")
    .bind(requested.outboxId)
    .first<{ subject_id: string }>();
  return { subjectId: row?.subject_id as string, outboxId: requested.outboxId };
}

/** The claim request key with its workspace replaced by another's. */
export function foreignClaimKey(subjectId: string, workspaceId: string): string {
  const claimRequestId = subjectId.split(":")[1] as string;
  return encodeClaimRequestKey({ workspaceId, claimRequestId });
}

/** Unsent outbox rows of one kind and subject. */
export async function queued(kind: string, subjectId: string): Promise<string[]> {
  const { results } = await env.DB.prepare(
    "SELECT id FROM outbox WHERE kind = ? AND subject_id = ? AND sent_at IS NULL",
  )
    .bind(kind, subjectId)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}
