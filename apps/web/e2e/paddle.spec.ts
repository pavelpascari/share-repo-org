import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { connectedCreator } from "./support/github.ts";
import { expect, signIn, test } from "./support/journeys.ts";
import {
  authorizeOnFakeGitHub,
  buyerEmail,
  buyerPage,
  claimLinkFor,
  connectPaddle,
  createPaddleOffer,
  directCheckoutUrl,
  type FakeSeller,
  fakeSeller,
  payOnFakePaddle,
  revokeKey,
  sellerSubscriptions,
  subscriptionControl,
} from "./support/paddle.ts";
import {
  acceptInvitation,
  checkUntil,
  registeredAccount,
  repositoryAccess,
} from "./support/provisioning.ts";

// Phase 5 journeys against the fake Paddle (support/fake-paddle.ts): connecting Paddle, buying
// through ShareRepo's checkout page (decision 0012, path 1), claiming a purchase made through a
// link shared from Paddle by email (path 2), a cancellation scheduled in Paddle, and a revoked key.
// Paddle's signed webhooks reach the web Worker; the dev server runs no crons, so reconciliation
// starts from "Check now" (support/provisioning.ts).

// Each journey waits on several queued runs in turn, beside the rest of the suite in parallel.
test.describe.configure({ timeout: 120_000 });

const WORKSPACE = "Creator Studio";

/** A creator with GitHub and Paddle connected and an offer selling `course-code`. */
async function sellingCreator(page: Page, request: APIRequestContext) {
  const { account, slug } = await connectedCreator(page);
  const repository = `${account.login}/course-code`;
  const seller = await fakeSeller(request);
  await connectPaddle(page, slug, seller);
  const offerId = await createPaddleOffer(page, slug, repository, seller);
  return { slug, repository, seller, offerId };
}

/** A registered GitHub account buys the offer through `/buy/<offerId>`, signing in on the way. */
async function buyThroughShareRepo(browser: Browser, request: APIRequestContext, offerId: string) {
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

test("an owner connects Paddle and the catalog shows its prices", async ({ page, request }) => {
  const { slug } = await connectedCreator(page);
  const seller = await fakeSeller(request);
  await connectPaddle(page, slug, seller);

  const account = page.getByRole("region", { name: "Paddle account" });
  await expect(account).toContainText(`Creator Studio Ltd (${seller.sellerId})`);
  await expect(account).toContainText("Sandbox");
  await expect(account).toContainText("Active");
  const catalog = page.getByRole("region", { name: "Catalog" });
  const row = catalog.getByRole("row").filter({ hasText: seller.price.id });
  await expect(row).toContainText("Course access");
  await expect(row).toContainText("12.00 USD per month");
  await expect(row).toContainText("Active");
  await expect(page.getByRole("region", { name: "Checkout page" })).toContainText(
    'Paddle.Environment.set("sandbox");',
  );
});

test("a buyer pays through ShareRepo's checkout, accepts the invitation and sees their access", async ({
  page,
  request,
  browser,
}) => {
  const { slug, repository, offerId } = await sellingCreator(page, request);
  const { buyer, page: buyerTab } = await buyThroughShareRepo(browser, request, offerId);

  // The signed webhooks lead ShareRepo to read the subscription and link it through the claim
  // reference; "Check now" then invites the buyer.
  await checkUntil(page, slug, repository, buyer.login, [
    `Invitation sent, waiting for @${buyer.login} to accept`,
  ]);
  await buyerTab.goto("/me/access");
  await expect(buyerTab.getByRole("heading", { level: 1, name: "My access" })).toBeVisible();
  const purchase = buyerTab.getByRole("listitem", { name: WORKSPACE });
  await expect(purchase).toContainText(repository);
  await expect(
    purchase.getByRole("link", { name: "Accept the invitation on GitHub" }),
  ).toBeVisible();

  await acceptInvitation(request, repository, buyer);
  await checkUntil(page, slug, repository, buyer.login, ["Active", "Access is in place"]);
  await buyerTab.reload();
  await expect(purchase).toContainText(repository);
  await expect(purchase.getByRole("link", { name: "Accept the invitation on GitHub" })).toHaveCount(
    0,
  );

  // The Customers page shows the Paddle customer linked to the buyer.
  await page.goto(`/w/${slug}/customers`);
  const customers = page.getByRole("listitem").filter({ hasText: `@${buyer.login}` });
  await expect(customers).toHaveCount(1);
  await expect(customers).toContainText("ctm_");
});

test("timing/cancellation-revokes-at-effective-time: a cancellation scheduled in Paddle removes access when it takes effect", async ({
  page,
  request,
  browser,
}) => {
  const { slug, repository, offerId } = await sellingCreator(page, request);
  const {
    buyer,
    page: buyerTab,
    subscriptionId,
  } = await buyThroughShareRepo(browser, request, offerId);
  await checkUntil(page, slug, repository, buyer.login, ["Invitation sent"]);
  await acceptInvitation(request, repository, buyer);
  await checkUntil(page, slug, repository, buyer.login, ["Access is in place"]);

  // The subscriber cancels in Paddle at the end of the period, an hour from now.
  const effectiveAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const scheduled = await subscriptionControl(request, subscriptionId, "schedule-cancel", {
    effective_at: effectiveAt,
  });
  expect(scheduled.scheduled_change).toEqual(
    expect.objectContaining({ action: "cancel", effective_at: effectiveAt }),
  );
  await expect
    .poll(
      async () => {
        await buyerTab.goto("/me/access");
        return buyerTab.getByRole("listitem", { name: WORKSPACE }).textContent();
      },
      { timeout: 20_000, message: "the scheduled cancellation is shown" },
    )
    .toContain("Cancels ");
  // Until then, access stays.
  await checkUntil(page, slug, repository, buyer.login, ["Access is in place"]);

  // At the effective time Paddle cancels the subscription and sends subscription.canceled; the
  // fake's clock is moved there by applying the cancellation now.
  const canceled = await subscriptionControl(request, subscriptionId, "cancel");
  expect(canceled.status).toBe("canceled");
  await checkUntil(page, slug, repository, buyer.login, ["Removed"]);
  expect((await repositoryAccess(request, repository)).collaborators).toEqual([]);
  await buyerTab.goto("/me/access");
  await expect(buyerTab.getByRole("listitem", { name: WORKSPACE })).toContainText("Ended");
});

test("a purchase through a link shared from Paddle is claimed by email and gives access", async ({
  page,
  request,
  browser,
}) => {
  const { slug, repository, seller } = await sellingCreator(page, request);

  // The buyer pays through a checkout the creator shared from Paddle: no ShareRepo reference.
  const buyerTab = await buyerPage(browser);
  const email = buyerEmail();
  await buyerTab.goto(await directCheckoutUrl(request, seller));
  const subscriptionId = await payOnFakePaddle(buyerTab, email);
  const customerId = (await subscriptionIn(request, seller, subscriptionId)).customer_id;
  // ShareRepo records the purchase from the webhooks, unclaimed.
  await expect
    .poll(
      async () => {
        await page.goto(`/w/${slug}/customers`);
        return page.getByRole("listitem", { name: customerId }).count();
      },
      { timeout: 20_000, message: "the customer is recorded" },
    )
    .toBe(1);
  await expect(page.getByRole("listitem", { name: customerId })).toContainText("Not claimed");

  // The buyer signs in and asks for a claim link at the email they paid with.
  const buyer = await registeredAccount(request);
  await signIn(buyerTab, buyer);
  await buyerTab.goto(`/c/${slug}/claim`);
  await expect(buyerTab.getByRole("heading", { level: 1, name: "Claim a purchase" })).toBeVisible();
  await buyerTab.getByLabel("Email address").fill(email);
  await buyerTab.getByRole("button", { name: "Send claim link" }).click();
  await expect(buyerTab.getByRole("status")).toContainText(
    "If that email address paid for a subscription here, we've sent it a link",
  );

  // The emailed link confirms first; claiming links the customer to the buyer.
  await buyerTab.goto(await claimLinkFor(request, email));
  await expect(
    buyerTab.getByText(`Access goes to the GitHub account @${buyer.login}`),
  ).toBeVisible();
  await buyerTab.getByRole("button", { name: "Claim purchase" }).click();
  await expect(buyerTab.getByRole("heading", { level: 1, name: "Purchase claimed" })).toBeVisible();
  await buyerTab.getByRole("link", { name: "See my access" }).click();
  await expect(buyerTab.getByRole("heading", { level: 1, name: "My access" })).toBeVisible();

  // The link queued a refresh; the buyer is then invited.
  await checkUntil(page, slug, repository, buyer.login, [
    `Invitation sent, waiting for @${buyer.login} to accept`,
  ]);
  await buyerTab.reload();
  await expect(buyerTab.getByRole("listitem", { name: WORKSPACE })).toContainText(repository);
  await page.goto(`/w/${slug}/customers`);
  await expect(page.getByRole("listitem", { name: customerId })).toContainText(`@${buyer.login}`);
});

test("connection/revoked-key-keeps-last-facts: a revoked key shows that Paddle needs a new API key", async ({
  page,
  request,
}) => {
  const { slug } = await connectedCreator(page);
  const seller = await fakeSeller(request);
  await connectPaddle(page, slug, seller);

  await revokeKey(request, seller);
  await page.getByRole("button", { name: "Refresh catalog" }).click();
  await expect(page.getByRole("alert").first()).toBeVisible();
  await page.goto(`/w/${slug}/billing`);
  const account = page.getByRole("region", { name: "Paddle account" });
  await expect(account).toContainText("Needs a new API key");
  await expect(account.getByRole("alert")).toContainText("Paddle refused the API key");
  // The catalog stays as last imported.
  await expect(page.getByRole("region", { name: "Catalog" })).toContainText(seller.price.id);
  await expect(page.getByRole("region", { name: "Reconnect" })).toBeVisible();
});

async function subscriptionIn(
  request: APIRequestContext,
  seller: FakeSeller,
  subscriptionId: string,
) {
  const subscription = (await sellerSubscriptions(request, seller)).find(
    (sub) => sub.id === subscriptionId,
  );
  expect(subscription, subscriptionId).toBeDefined();
  return subscription as NonNullable<typeof subscription>;
}
