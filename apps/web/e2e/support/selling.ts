import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { connectedCreator } from "./github.ts";
import { expect, newGitHubAccount } from "./journeys.ts";
import {
  authorizeOnFakeGitHub,
  buyerEmail,
  buyerPage,
  connectPaddle,
  createPaddleOffer,
  directCheckoutUrl,
  type FakeSeller,
  fakeSeller,
  payOnFakePaddle,
  sellerSubscriptions,
} from "./paddle.ts";
import { registeredAccount } from "./provisioning.ts";

// A creator selling a repository through the fake Paddle, and buyers paying for it, shared by
// the specs that follow a Paddle subscription (paddle, operations and timing).

/** A creator with GitHub and Paddle connected and an offer selling `course-code`. */
export async function sellingCreator(
  page: Page,
  request: APIRequestContext,
  workspaceName = "Creator Studio",
) {
  const { account, slug } = await connectedCreator(page, newGitHubAccount(), workspaceName);
  const repository = `${account.login}/course-code`;
  const seller = await fakeSeller(request);
  await connectPaddle(page, slug, seller);
  const offerId = await createPaddleOffer(page, slug, repository, seller);
  return { slug, repository, seller, offerId };
}

/** A registered GitHub account buys the offer through `/buy/<offerId>`, signing in on the way. */
export async function buyThroughShareRepo(
  browser: Browser,
  request: APIRequestContext,
  offerId: string,
) {
  const buyer = await registeredAccount(request);
  const page = await buyerPage(browser);
  await page.goto(`/buy/${offerId}`);
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await authorizeOnFakeGitHub(page, buyer);
  // Back on the checkout page after signing in.
  await expect(page.getByRole("heading", { level: 1, name: "Course access" })).toBeVisible();
  await expect(page.getByText(`Access goes to the GitHub account @${buyer.login}`)).toBeVisible();
  await expect(page.getByRole("radiogroup", { name: "Price" })).toContainText("12.00 USD");
  await page.getByRole("button", { name: "Continue to checkout" }).click();
  const subscriptionId = await payOnFakePaddle(page, buyerEmail());
  return { buyer, page, subscriptionId };
}

/**
 * Someone pays through a checkout the creator shared from Paddle (no ShareRepo reference, so no
 * GitHub account), and ShareRepo records the purchase: the Customers page lists the customer with
 * the subscription active. Returns the subscription and customer IDs.
 */
export async function directPurchase(
  page: Page,
  request: APIRequestContext,
  browser: Browser,
  slug: string,
  seller: FakeSeller,
) {
  const buyerTab = await buyerPage(browser);
  await buyerTab.goto(await directCheckoutUrl(request, seller));
  const subscriptionId = await payOnFakePaddle(buyerTab, buyerEmail());
  await buyerTab.context().close();
  const subscription = (await sellerSubscriptions(request, seller)).find(
    (sub) => sub.id === subscriptionId,
  );
  const customerId = subscription?.customer_id ?? "";
  await expectCustomerSubscription(page, slug, customerId, `${subscriptionId}: Active`);
  return { subscriptionId, customerId };
}

/** Reloads the Customers page until the customer's card shows `text`. */
export async function expectCustomerSubscription(
  page: Page,
  slug: string,
  customerId: string,
  text: string,
) {
  await expect
    .poll(
      async () => {
        await page.goto(`/w/${slug}/customers`);
        const card = page.getByRole("listitem", { name: customerId });
        return (await card.count()) === 0 ? "" : ((await card.textContent()) ?? "");
      },
      { timeout: 20_000, message: `customer ${customerId} shows "${text}"` },
    )
    .toContain(text);
}
