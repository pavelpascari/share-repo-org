import type { APIRequestContext, Page } from "@playwright/test";
import {
  createWorkspace,
  expect,
  newGitHubAccount,
  signIn,
  test,
  uniqueSlug,
} from "./support/journeys.ts";
import {
  buyerPage,
  type FakeSeller,
  failNextPaddleCall,
  redeliver,
  subscriptionControl,
} from "./support/paddle.ts";
import { OPERATOR_GITHUB_ID } from "./support/ports.ts";
import { directPurchase, expectCustomerSubscription, sellingCreator } from "./support/selling.ts";

// Phase 6 failure handling (decision 0014) in the browser: a job that fails for good is shown to
// the workspace's owner on the Access page and to operators on /ops, either of whom can retry it;
// operators can also dismiss it with a reason. Everyone else gets a 404 on /ops.
//
// A failure is made with the fake Paddle: its next subscription read answers 400, which is not
// worth retrying, so the refresh that a Paddle webhook queued fails at once.

test.describe.configure({ timeout: 120_000 });

/** What the Access page and /ops call a failed subscription refresh. */
const REFRESH_JOB = "Updating a subscriber's access";
const REFUSED = "GitHub or Paddle refused the request.";

/**
 * A creator in a uniquely named workspace (so /ops rows can be told apart) with one purchase
 * recorded from Paddle.
 */
async function creatorWithPurchase(
  page: Page,
  request: APIRequestContext,
  browser: Parameters<typeof directPurchase>[2],
) {
  const workspaceName = `Studio ${uniqueSlug()}`;
  const { slug, seller } = await sellingCreator(page, request, workspaceName);
  const purchase = await directPurchase(page, request, browser, slug, seller);
  // The purchase's webhooks each queued a refresh; let the last of them run before the next read
  // is made to fail, so that the failure is the cancellation's refresh below.
  await page.waitForTimeout(6_000);
  return { workspaceName, slug, seller, ...purchase };
}

/** Paddle refuses the next subscription read, then a webhook asks ShareRepo for a refresh. */
async function failNextRefresh(
  request: APIRequestContext,
  seller: FakeSeller,
  webhook: () => Promise<unknown>,
) {
  await failNextPaddleCall(request, seller, "getSubscription", "rejected");
  await webhook();
}

/** Reloads `path` until `locator(page)` matches `count` elements. */
async function expectCount(
  page: Page,
  path: string,
  locate: (page: Page) => ReturnType<Page["getByRole"]>,
  count: number,
  message: string,
) {
  await expect
    .poll(
      async () => {
        await page.goto(path);
        return locate(page).count();
      },
      { timeout: 30_000, message },
    )
    .toBe(count);
}

test("failure/owner-sees-only-own-failures: an owner sees a failed job on the Access page and retries it", async ({
  page,
  request,
  browser,
}) => {
  const { slug, seller, subscriptionId, customerId } = await creatorWithPurchase(
    page,
    request,
    browser,
  );

  // The subscription is canceled in Paddle, but ShareRepo's refresh of it fails for good.
  await failNextRefresh(request, seller, () =>
    subscriptionControl(request, subscriptionId, "cancel"),
  );
  const failed = (on: Page) =>
    on.getByRole("region", { name: "Needs attention" }).getByRole("row", { name: REFRESH_JOB });
  await expectCount(page, `/w/${slug}/access`, failed, 1, "the failed refresh is listed");
  await expect(failed(page)).toContainText(REFUSED);
  await expectCustomerSubscription(page, slug, customerId, `${subscriptionId}: Active`);

  // Another owner's workspace lists nothing of it.
  const other = await buyerPage(browser);
  await signIn(other, newGitHubAccount());
  const otherSlug = await createWorkspace(other, "Elsewhere");
  await other.goto(`/w/${otherSlug}/access`);
  await expect(other.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(other.getByRole("region", { name: "Needs attention" })).toHaveCount(0);
  await other.context().close();

  // The owner retries: the refresh runs again, reads the cancellation, and the failure is gone.
  await page.goto(`/w/${slug}/access`);
  await failed(page).getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("status")).toHaveText("Retry queued.");
  await expectCustomerSubscription(page, slug, customerId, `${subscriptionId}: Canceled`);
  await expectCount(page, `/w/${slug}/access`, failed, 0, "the retried failure is gone");
});

test("an operator views, retries and dismisses failures on /ops", async ({
  page,
  request,
  browser,
}) => {
  const { workspaceName, slug, seller, subscriptionId, customerId } = await creatorWithPurchase(
    page,
    request,
    browser,
  );
  await failNextRefresh(request, seller, () =>
    subscriptionControl(request, subscriptionId, "cancel"),
  );

  const operator = await buyerPage(browser);
  await signIn(operator, { id: OPERATOR_GITHUB_ID, login: "sharerepo-operator", name: "Operator" });
  const failed = (on: Page) =>
    on
      .getByRole("region", { name: "Failed jobs" })
      .getByRole("row", { name: REFRESH_JOB })
      .filter({ hasText: workspaceName });
  await expectCount(operator, "/ops", failed, 1, "the failure is listed on /ops");
  await expect(operator.getByRole("heading", { level: 1, name: "Operations" })).toBeVisible();
  await expect(failed(operator)).toContainText(REFUSED);

  // The workspace's Access page, read-only.
  await failed(operator).getByRole("link", { name: "View access" }).click();
  await expect(operator).toHaveURL(`/ops/w/${slug}`);
  await expect(
    operator.getByRole("heading", { level: 1, name: `${workspaceName}: access` }),
  ).toBeVisible();
  await expect(
    operator.getByText("This visit is recorded in the workspace's audit history."),
  ).toBeVisible();
  const attention = operator.getByRole("region", { name: "Needs attention" });
  await expect(attention.getByRole("row", { name: REFRESH_JOB })).toContainText(REFUSED);
  await expect(attention.getByRole("button")).toHaveCount(0);

  // Retry: the refresh reads the cancellation.
  await operator.getByRole("link", { name: "Back to operations" }).click();
  await failed(operator).getByRole("button", { name: "Retry" }).click();
  await expect(operator.getByRole("status")).toHaveText("Retry queued.");
  await expectCustomerSubscription(page, slug, customerId, `${subscriptionId}: Canceled`);
  await expectCount(operator, "/ops", failed, 0, "the retried failure leaves /ops");

  // A second failure, which the operator dismisses with a reason.
  await failNextRefresh(request, seller, async () =>
    expect(await redeliver(request, seller, subscriptionId, "subscription.updated")).toEqual([200]),
  );
  await expectCount(operator, "/ops", failed, 1, "the second failure is listed on /ops");
  await failed(operator).getByLabel("Reason").fill("Fake Paddle refused one read on purpose.");
  await failed(operator).getByRole("button", { name: "Dismiss" }).click();
  await expect(operator.getByRole("status")).toHaveText("Dismissed.");
  await expectCount(operator, "/ops", failed, 0, "the dismissed failure leaves /ops");
  // Dismissed for the owner too.
  await page.goto(`/w/${slug}/access`);
  await expect(page.getByRole("region", { name: "Needs attention" })).toHaveCount(0);
  await operator.context().close();
});

test("operator/non-operator-gets-404: /ops answers 404 to visitors and to signed-in non-operators", async ({
  page,
}) => {
  expect((await page.goto("/ops"))?.status()).toBe(404);

  await signIn(page, newGitHubAccount());
  const slug = await createWorkspace(page, "Not an operator");
  expect((await page.goto("/ops"))?.status()).toBe(404);
  // Not even their own workspace's operator view.
  expect((await page.goto(`/ops/w/${slug}`))?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Operations" })).toHaveCount(0);
});
