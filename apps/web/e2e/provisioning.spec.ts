import { connectedCreator } from "./support/github.ts";
import { expect, test } from "./support/journeys.ts";
import {
  acceptInvitation,
  addCollaboratorByHand,
  addSubscriber,
  checkUntil,
  createOffer,
  expectAccess,
  failNext,
  registeredAccount,
  removeCollaboratorByHand,
  repositoryAccess,
  simulate,
} from "./support/provisioning.ts";

// Phase 4 journeys: simulated subscriptions change access on the fake GitHub repository, and the
// access page shows what GitHub lists. The dev server runs no crons, so every reconciliation here
// starts from "Check now" or "Retry" (see support/provisioning.ts).

const ITEM = "sim_monthly";

// Each journey waits on several queued runs in turn, beside the rest of the suite in parallel.
test.describe.configure({ timeout: 120_000 });

test("a subscriber is invited, accepts, is re-invited after a manual removal, and is removed on cancel", async ({
  page,
  request,
}) => {
  const { account, slug } = await connectedCreator(page);
  const repository = `${account.login}/course-code`;
  await createOffer(page, slug, repository, ITEM);
  const subscriber = await registeredAccount(request);
  const subscription = await addSubscriber(page, slug, subscriber.login, ITEM, "Trial");
  await subscription.getByRole("button", { name: "Activate" }).click();
  await expect(subscription).toContainText("Active");
  await expectAccess(page, slug, subscriber.login, ["Not checked yet", "Will invite"]);

  // Activated: ShareRepo invites the subscriber.
  await checkUntil(page, slug, repository, subscriber.login, [
    `Invitation sent, waiting for @${subscriber.login} to accept (expires `,
    "Waiting for the subscriber to accept",
    "Checked ",
  ]);
  const invited = await repositoryAccess(request, repository);
  expect(invited.invitations).toEqual([
    expect.objectContaining({ inviteeId: subscriber.id, expired: false }),
  ]);
  expect(invited.collaborators).toEqual([]);
  // An owner's controls; no error, so no Retry.
  await expect(page.getByRole("button", { name: "Retry" })).toHaveCount(0);

  // The subscriber accepts on GitHub.
  await acceptInvitation(request, repository, subscriber);
  await checkUntil(page, slug, repository, subscriber.login, ["Active", "Access is in place"]);

  // drift/manual-removal-is-repaired: the creator removes them by hand; ShareRepo invites again.
  await removeCollaboratorByHand(request, repository, subscriber);
  await checkUntil(page, slug, repository, subscriber.login, [
    `Invitation sent, waiting for @${subscriber.login} to accept`,
  ]);
  const reinvited = await repositoryAccess(request, repository);
  expect(reinvited.collaborators).toEqual([]);
  expect(reinvited.invitations).toHaveLength(1);
  expect(reinvited.invitations[0]?.id).not.toBe(invited.invitations[0]?.id);
  await acceptInvitation(request, repository, subscriber);
  await checkUntil(page, slug, repository, subscriber.login, ["Access is in place"]);

  // Cancelled now: ShareRepo removes the collaborator it added. Nothing is listed after the
  // removal, so observation settles it as removed in the same run (no grace for a revoke).
  await simulate(page, slug, subscriber.login, "Cancel now");
  await expectAccess(page, slug, subscriber.login, ["Ended", "Subscription canceled"]);
  await checkUntil(page, slug, repository, subscriber.login, ["Removed", "Nothing to do"]);
  expect(await repositoryAccess(request, repository)).toEqual({
    collaborators: [],
    invitations: [],
  });
});

test("drift/unmanaged-access-is-not-revoked: access added by hand is reported and left alone", async ({
  page,
  request,
}) => {
  const { account, slug } = await connectedCreator(page);
  const repository = `${account.login}/course-code`;
  await createOffer(page, slug, repository, ITEM);

  // The creator added this subscriber by hand before they subscribed.
  const handAdded = await registeredAccount(request);
  await addCollaboratorByHand(request, repository, handAdded);
  await addSubscriber(page, slug, handAdded.login, ITEM);
  // And another subscriber, whom ShareRepo invites.
  const invited = await registeredAccount(request);
  await addSubscriber(page, slug, invited.login, ITEM);
  await expectAccess(page, slug, invited.login, ["Will invite"]);
  await expectAccess(page, slug, handAdded.login, ["Subscription active"]);

  await checkUntil(page, slug, repository, invited.login, ["Invitation sent"]);
  await checkUntil(page, slug, repository, handAdded.login, [
    "Has access ShareRepo does not manage",
  ]);

  // Both cancel. Once the invited subscriber's invitation is withdrawn, the run that withdrew it
  // has seen both cancellations.
  await simulate(page, slug, handAdded.login, "Cancel now");
  await simulate(page, slug, invited.login, "Cancel now");
  await expectAccess(page, slug, handAdded.login, ["Ended"]);
  await expectAccess(page, slug, invited.login, ["Ended"]);
  await checkUntil(page, slug, repository, invited.login, ["Removed"]);
  await expectAccess(page, slug, handAdded.login, [
    "Has access ShareRepo does not manage",
    "Access not granted by ShareRepo, left as is",
  ]);
  expect(await repositoryAccess(request, repository)).toEqual({
    collaborators: [expect.objectContaining({ id: handAdded.id, login: handAdded.login })],
    invitations: [],
  });
});

test("an invitation refused by GitHub's rate limit waits to retry, and the owner can retry it", async ({
  page,
  request,
}) => {
  const { account, slug } = await connectedCreator(page);
  const repository = `${account.login}/course-code`;
  await createOffer(page, slug, repository, ITEM);
  const subscriber = await registeredAccount(request);
  await addSubscriber(page, slug, subscriber.login, ITEM);
  await expectAccess(page, slug, subscriber.login, ["Will invite"]);

  // GitHub answers the next invitation on this repository with 429, retry after an hour.
  await failNext(request, repository, "addCollaborator", 429, 3600);
  await checkUntil(page, slug, repository, subscriber.login, [
    "Error: GitHub's rate limit was reached",
    "ShareRepo waits until GitHub allows more changes, then tries again.",
    "Retrying at ",
    "Waiting to retry at ",
  ]);
  expect((await repositoryAccess(request, repository)).invitations).toEqual([]);

  // The owner retries now rather than in an hour.
  const row = page.getByRole("row").filter({ hasText: subscriber.login });
  await row.getByRole("button", { name: "Retry" }).click();
  await expect(page.getByRole("status")).toHaveText("Retry queued.");
  await expectAccess(page, slug, subscriber.login, ["Invitation sent"]);
  expect((await repositoryAccess(request, repository)).invitations).toEqual([
    expect.objectContaining({ inviteeId: subscriber.id }),
  ]);
});
