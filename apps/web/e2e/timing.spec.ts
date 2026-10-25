import type { APIRequestContext, Browser, Page } from "@playwright/test";
import { expect, test } from "./support/journeys.ts";
import { deliverWebhooks, loseWebhooks, redeliver, subscriptionControl } from "./support/paddle.ts";
import {
  acceptInvitation,
  checkNow,
  checkUntil,
  expectAccess,
  repositoryAccess,
} from "./support/provisioning.ts";
import { buyThroughShareRepo, sellingCreator } from "./support/selling.ts";

// Expiry confirmation (decision 0013) in the browser. A subscription's end date passes while the
// webhook that would have explained it is lost: ShareRepo keeps the subscriber's access ("Ending:
// confirming with Paddle") and schedules the bounded revoke at the end date plus the 6-hour
// confirmation window, until a refresh re-reads Paddle. Paddle's retry of the lost webhook
// triggers that refresh here; in production the minute sweep does. The dev server runs no crons,
// so reconciliation starts from "Check now".

test.describe.configure({ timeout: 180_000 });

const CONFIRMATION_WINDOW_MS = 6 * 60 * 60 * 1000;
/** How far ahead the cancellation is scheduled: long enough for its webhook to be processed. */
const BOUNDARY_IN_SECONDS = 20;

/** As the access page writes an instant (formatInstant). */
const minuteUtc = (at: number) =>
  `${new Date(at).toISOString().slice(0, 16).replace("T", " ")} UTC`;

/** A buyer with access in place to the creator's repository, bought through Paddle. */
async function subscriberWithAccess(page: Page, request: APIRequestContext, browser: Browser) {
  const { slug, repository, seller, offerId } = await sellingCreator(page, request);
  const {
    buyer,
    page: buyerTab,
    subscriptionId,
  } = await buyThroughShareRepo(browser, request, offerId);
  await buyerTab.context().close();
  await checkUntil(page, slug, repository, buyer.login, ["Invitation sent"]);
  await acceptInvitation(request, repository, buyer);
  await checkUntil(page, slug, repository, buyer.login, ["Access is in place"]);
  return { slug, repository, seller, buyer, subscriptionId };
}

/**
 * Schedules a cancellation a few seconds ahead, delivered and recorded by ShareRepo; returns its
 * effective instant.
 */
async function scheduleCancellation(
  page: Page,
  request: APIRequestContext,
  slug: string,
  login: string,
  subscriptionId: string,
): Promise<number> {
  const scheduled = await subscriptionControl(request, subscriptionId, "schedule-cancel", {
    effective_in_seconds: String(BOUNDARY_IN_SECONDS),
  });
  const effectiveAt = Date.parse(scheduled.scheduled_change?.effective_at ?? "");
  expect(effectiveAt).toBeGreaterThan(Date.now());
  await expectAccess(page, slug, login, ["Cancellation scheduled"]);
  return effectiveAt;
}

/**
 * Once the end date has passed: the access page says ShareRepo is confirming with Paddle, and a
 * check removes nothing but schedules the bounded revoke at the end of the confirmation window.
 */
async function expectExpiryPending(
  page: Page,
  request: APIRequestContext,
  input: { slug: string; repository: string; login: string; buyerId: string; effectiveAt: number },
) {
  const { slug, repository, login, buyerId, effectiveAt } = input;
  await expectAccess(page, slug, login, ["Ending: confirming with Paddle"]);
  expect(Date.now()).toBeGreaterThan(effectiveAt);
  const nextCheck = `next check ${minuteUtc(effectiveAt + CONFIRMATION_WINDOW_MS)}`;
  await expect
    .poll(
      async () => {
        await page.goto(`/w/${slug}/access`);
        const text = (await page.getByRole("listitem", { name: repository }).textContent()) ?? "";
        if (!text.includes(nextCheck)) await checkNow(page, repository);
        return text;
      },
      { timeout: 30_000, intervals: [1_000, 2_000], message: "the post-boundary check ran" },
    )
    .toContain(nextCheck);
  await expectAccess(page, slug, login, ["Ending: confirming with Paddle"]);
  expect((await repositoryAccess(request, repository)).collaborators).toEqual([
    expect.objectContaining({ id: buyerId }),
  ]);
}

test("timing/stale-workflow-cannot-revoke-renewed: a subscriber whose renewal webhook was lost keeps access past the old end date", async ({
  page,
  request,
  browser,
}) => {
  const { slug, repository, seller, buyer, subscriptionId } = await subscriberWithAccess(
    page,
    request,
    browser,
  );
  const effectiveAt = await scheduleCancellation(page, request, slug, buyer.login, subscriptionId);

  // The subscriber changes their mind before the end date: Paddle removes the scheduled
  // cancellation, but its webhook is lost. ShareRepo still holds the old end date.
  await loseWebhooks(request, subscriptionId);
  const kept = await subscriptionControl(
    request,
    subscriptionId,
    "remove-scheduled-change",
    {},
    { destinations: 0 },
  );
  expect(kept.scheduled_change).toBeNull();

  // The end date passes. The subscriber keeps access while ShareRepo confirms with Paddle.
  await expectExpiryPending(page, request, {
    slug,
    repository,
    login: buyer.login,
    buyerId: buyer.id,
    effectiveAt,
  });

  // Paddle retries the lost webhook; the refresh finds the subscription renewed, and the same
  // access simply continues.
  await deliverWebhooks(request, subscriptionId);
  expect(await redeliver(request, seller, subscriptionId, "subscription.updated")).toEqual([200]);
  await checkUntil(page, slug, repository, buyer.login, [
    "Subscription active",
    "Access is in place",
  ]);
  const access = await repositoryAccess(request, repository);
  expect(access.collaborators).toEqual([expect.objectContaining({ id: buyer.id })]);
  expect(access.invitations).toEqual([]);
});

test("timing/expiry-confirmed-before-revoke: a cancellation whose webhook was lost removes access only once a refresh confirms it", async ({
  page,
  request,
  browser,
}) => {
  const { slug, repository, seller, buyer, subscriptionId } = await subscriberWithAccess(
    page,
    request,
    browser,
  );
  const effectiveAt = await scheduleCancellation(page, request, slug, buyer.login, subscriptionId);

  // At the end date Paddle cancels the subscription, but its subscription.canceled webhook is
  // lost.
  await loseWebhooks(request, subscriptionId);
  await expectExpiryPending(page, request, {
    slug,
    repository,
    login: buyer.login,
    buyerId: buyer.id,
    effectiveAt,
  });

  // Paddle retries the webhook; the refresh confirms the cancellation and access is removed.
  await deliverWebhooks(request, subscriptionId);
  expect(await redeliver(request, seller, subscriptionId, "subscription.canceled")).toEqual([200]);
  await checkUntil(page, slug, repository, buyer.login, ["Removed"]);
  expect((await repositoryAccess(request, repository)).collaborators).toEqual([]);
});
