import { randomBytes, randomInt } from "node:crypto";
import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { expect, type GitHubAccount } from "./journeys.ts";
import { FAKE_PADDLE_URL, WEB_URL } from "./ports.ts";

// Selling through the fake Paddle (e2e/support/fake-paddle.ts): a seller per test, connecting it
// on the Billing page, Paddle offers, paying on the fake default payment link, and the fake's
// lifecycle controls and mailbox. Paddle's webhooks reach the web Worker, which hands them to the
// jobs Worker through the queue; the refresh an event or a customer link queues follows through
// the queue too. The dev server runs no crons, so reconciliation starts from "Check now".

export interface FakeSeller {
  readonly sellerId: string;
  /** A sandbox API key in Paddle's current format, known only to this seller's fake. */
  readonly key: string;
  readonly price: { readonly id: string; readonly label: string };
}

const ALPHANUMERIC = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const text = (alphabet: string, length: number) =>
  Array.from({ length }, () => alphabet[randomInt(alphabet.length)]).join("");

/** `pdl_sdbx_apikey_` + 26 + `_` + 22 + `_` + 3 characters, as Paddle issues sandbox keys. */
export function sandboxApiKey(): string {
  const lower = ALPHANUMERIC.slice(0, 26) + ALPHANUMERIC.slice(52);
  return `pdl_sdbx_apikey_${text(lower, 26)}_${text(ALPHANUMERIC, 22)}_${text(ALPHANUMERIC, 3)}`;
}

/** An email address unique to this run, for a buyer at the fake checkout. */
export function buyerEmail(): string {
  return `buyer-${randomBytes(6).toString("hex")}@example.com`;
}

async function control<T>(
  request: APIRequestContext,
  path: string,
  form: Record<string, string> = {},
): Promise<T> {
  const response = await request.post(`${FAKE_PADDLE_URL}/_control${path}`, { form });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
  return (await response.json()) as T;
}

/** A seller in the fake Paddle with one monthly price of 12.00 USD for "Course access". */
export async function fakeSeller(request: APIRequestContext): Promise<FakeSeller> {
  const key = sandboxApiKey();
  const { sellerId } = await control<{ sellerId: string }>(request, "/sellers", {
    key,
    name: "Creator Studio Ltd",
  });
  const price = await control<{ id: string }>(request, `/sellers/${sellerId}/prices`, {
    product_name: "Course access",
    description: "Monthly",
    amount: "1200",
    currency: "USD",
    interval: "month",
  });
  return {
    sellerId,
    key,
    price: { id: price.id, label: "Course access (Monthly) — 12.00 USD per month" },
  };
}

/** Connects the seller's key on the Billing page. */
export async function connectPaddle(page: Page, slug: string, seller: FakeSeller) {
  await page.goto(`/w/${slug}/billing`);
  const connect = page.getByRole("region", { name: "Connect Paddle" });
  await connect.getByLabel("API key").fill(seller.key);
  await connect.getByLabel("Key expiry date").fill("2027-12-31");
  await connect.getByRole("button", { name: "Connect Paddle" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Paddle is connected and the catalog is imported.",
  );
}

/** Creates an offer selling one repository through the seller's price; returns its ID. */
export async function createPaddleOffer(
  page: Page,
  slug: string,
  repository: string,
  seller: FakeSeller,
  name = "Course access",
): Promise<string> {
  await page.goto(`/w/${slug}/offers`);
  await page.getByLabel("Name", { exact: true }).fill(name);
  await page.getByText(repository).click();
  await page.getByRole("group", { name: "Paddle prices" }).getByText(seller.price.label).click();
  await page.getByRole("button", { name: "Create offer" }).click();
  await expect(page.getByRole("status")).toHaveText(`Created “${name}”.`);
  const link = await page.getByLabel(`Checkout link for ${name}`).inputValue();
  expect(link).toMatch(new RegExp(`^${WEB_URL}/buy/[^/]+$`));
  return link.slice(`${WEB_URL}/buy/`.length);
}

/** A second browser context for the buyer, with its own client IP like the `test` fixture. */
export async function buyerPage(browser: Browser): Promise<Page> {
  const context = await browser.newContext({
    baseURL: WEB_URL,
    extraHTTPHeaders: { "cf-connecting-ip": `203.0.${randomInt(0, 256)}.${randomInt(1, 255)}` },
  });
  return context.newPage();
}

/** Completes the fake GitHub authorize page a sign-in prompt led to. */
export async function authorizeOnFakeGitHub(page: Page, account: GitHubAccount) {
  await expect(page.getByRole("heading", { name: "Authorize ShareRepo" })).toBeVisible();
  await page.getByLabel("GitHub ID").fill(account.id);
  await page.getByLabel("Login").fill(account.login);
  await page.getByLabel("Name").fill(account.name ?? "");
  await page.getByRole("button", { name: "Authorize" }).click();
}

/** Pays on the fake default payment link the page is on; returns the new subscription's ID. */
export async function payOnFakePaddle(page: Page, email: string): Promise<string> {
  await expect(page.getByRole("heading", { name: "Checkout" })).toBeVisible();
  await page.getByLabel("Email").fill(email);
  await page.getByRole("button", { name: "Pay" }).click();
  await expect(page.getByRole("heading", { name: "Payment complete" })).toBeVisible();
  const subscriptionId = await page.locator("code").textContent();
  expect(subscriptionId).toMatch(/^sub_[a-z\d]{26}$/);
  return subscriptionId as string;
}

/** A checkout the creator shared from Paddle directly: it carries no ShareRepo reference. */
export async function directCheckoutUrl(
  request: APIRequestContext,
  seller: FakeSeller,
): Promise<string> {
  const created = await control<{ checkout_url: string }>(
    request,
    `/sellers/${seller.sellerId}/transactions`,
    { price_id: seller.price.id },
  );
  return created.checkout_url;
}

/** What the fake holds for a subscription, in Paddle's wire format. */
export interface WireSubscription {
  readonly id: string;
  readonly status: string;
  readonly customer_id: string;
  readonly scheduled_change: { action: string; effective_at: string } | null;
}

/** Applies a lifecycle control to a subscription and sends Paddle's event for it. */
export async function subscriptionControl(
  request: APIRequestContext,
  subscriptionId: string,
  action:
    | "schedule-cancel"
    | "remove-scheduled-change"
    | "cancel"
    | "past-due"
    | "renew"
    | "activate"
    | "pause"
    | "resume",
  form: Record<string, string> = {},
  options: { destinations?: number } = {},
) {
  const result = await control<{
    subscription: WireSubscription;
    deliveries: { status: number }[];
  }>(request, `/subscriptions/${subscriptionId}/${action}`, form);
  // One delivery per active destination (two during a webhook secret rotation, none while the
  // subscription's webhooks are lost), each accepted.
  expect(result.deliveries.map((delivery) => delivery.status)).toEqual(
    Array.from({ length: options.destinations ?? 1 }, () => 200),
  );
  return result.subscription;
}

/** Paddle loses this subscription's webhooks from now on: changes apply, nothing is delivered. */
export const loseWebhooks = (request: APIRequestContext, subscriptionId: string) =>
  control(request, `/subscriptions/${subscriptionId}/lose-webhooks`);

/** Paddle delivers this subscription's webhooks again. */
export const deliverWebhooks = (request: APIRequestContext, subscriptionId: string) =>
  control(request, `/subscriptions/${subscriptionId}/deliver-webhooks`);

/**
 * Paddle delivers an event carrying the subscription as it is now, as its retry of a lost
 * delivery does; returns each destination's response status.
 */
export async function redeliver(
  request: APIRequestContext,
  seller: FakeSeller,
  subscriptionId: string,
  eventType: string,
): Promise<number[]> {
  const { deliveries } = await control<{ deliveries: { status: number }[] }>(
    request,
    `/sellers/${seller.sellerId}/events`,
    { event_type: eventType, subscription_id: subscriptionId },
  );
  return deliveries.map((delivery) => delivery.status);
}

/** The seller's next call of `operation` fails with `kind`, as Paddle answers it. */
export const failNextPaddleCall = (
  request: APIRequestContext,
  seller: FakeSeller,
  operation: string,
  kind: "rejected" | "transient" | "not_found" | "rate_limited" | "unauthorized",
) => control(request, `/sellers/${seller.sellerId}/fail-next`, { operation, kind });

/** ShareRepo's notification destinations in the seller's fake. */
export async function destinations(
  request: APIRequestContext,
  seller: FakeSeller,
): Promise<{ id: string; destination: string; active: boolean }[]> {
  const response = await request.get(`${FAKE_PADDLE_URL}/_control/sellers/${seller.sellerId}`);
  expect(response.ok()).toBe(true);
  return (
    (await response.json()) as {
      notificationSettings: { id: string; destination: string; active: boolean }[];
    }
  ).notificationSettings;
}

/** The seller's subscriptions in the fake. */
export async function sellerSubscriptions(
  request: APIRequestContext,
  seller: FakeSeller,
): Promise<WireSubscription[]> {
  const response = await request.get(`${FAKE_PADDLE_URL}/_control/sellers/${seller.sellerId}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { subscriptions: WireSubscription[] }).subscriptions;
}

export const revokeKey = (request: APIRequestContext, seller: FakeSeller) =>
  control(request, `/sellers/${seller.sellerId}/revoke-key`);

/**
 * The mail the fake captured for this address. A transient request error (the fake's socket
 * reset, a response cut short) reads as no mail yet, so the caller's poll simply tries again.
 */
async function mailTo(request: APIRequestContext, email: string): Promise<{ text: string }[]> {
  try {
    const response = await request.get(
      `${FAKE_PADDLE_URL}/_control/mail?to=${encodeURIComponent(email)}`,
    );
    if (!response.ok()) return [];
    return (await response.json()) as { text: string }[];
  } catch {
    return [];
  }
}

/** The claim link ShareRepo emailed to this address, once the mail arrives. */
export async function claimLinkFor(request: APIRequestContext, email: string): Promise<string> {
  let link = "";
  await expect
    .poll(
      async () => {
        const mails = await mailTo(request, email);
        link = mails[0]?.text.match(new RegExp(`${WEB_URL}/claim/[A-Za-z0-9_-]+`))?.[0] ?? "";
        return link;
      },
      { timeout: 20_000, message: `claim email to ${email}` },
    )
    .not.toBe("");
  return link;
}
