import { connectedCreator } from "./support/github.ts";
import { expect, test } from "./support/journeys.ts";
import {
  acceptInvitation,
  checkUntil,
  createOffer,
  registeredAccount,
  repositoryAccess,
} from "./support/provisioning.ts";

// Manual access (decision 0016): an owner grants an offer's repositories to a GitHub account by
// hand, with no purchase, and revokes it. The dev server runs no crons, so reconciliations run
// from the queue hand-off and "Check now" (see support/provisioning.ts).

test.describe.configure({ timeout: 120_000 });

test("manual/owner-grants-and-revokes-by-login: the account is invited, accepts, and is removed on revoke", async ({
  page,
  request,
}) => {
  const { account, slug } = await connectedCreator(page);
  const repository = `${account.login}/course-code`;
  await createOffer(page, slug, repository, "sim_manual");
  const buyer = await registeredAccount(request);

  // The owner grants the offer to the early buyer's GitHub login, with no subscription.
  await page.goto(`/w/${slug}/manual-access`);
  await page.getByLabel("GitHub login").fill(buyer.login);
  await page.getByLabel("Note (optional)").fill("early buyer");
  await page.getByRole("button", { name: "Grant access" }).click();
  await expect(page.getByRole("status")).toHaveText(
    `Granted access to @${buyer.login}. ShareRepo is inviting them on GitHub.`,
  );
  const grant = page.getByRole("listitem", { name: buyer.login });
  await expect(grant).toContainText("Active");
  await expect(grant).toContainText("early buyer");

  // ShareRepo invites the account on GitHub; it accepts.
  await checkUntil(page, slug, repository, buyer.login, [
    `Invitation sent, waiting for @${buyer.login} to accept`,
    "Manual access, granted by an owner",
  ]);
  expect((await repositoryAccess(request, repository)).invitations).toEqual([
    expect.objectContaining({ inviteeId: buyer.id }),
  ]);
  await acceptInvitation(request, repository, buyer);
  await checkUntil(page, slug, repository, buyer.login, ["Access is in place"]);

  // The owner revokes it; ShareRepo removes the collaborator it added.
  await page.goto(`/w/${slug}/manual-access`);
  await page
    .getByRole("listitem", { name: buyer.login })
    .getByRole("button", { name: "Revoke" })
    .click();
  await expect(page.getByRole("status")).toHaveText(
    "Access revoked. ShareRepo is removing it on GitHub.",
  );
  await expect(page.getByRole("listitem", { name: buyer.login })).toContainText("Revoked");
  await checkUntil(page, slug, repository, buyer.login, ["Removed", "Nothing to do"]);
  expect(await repositoryAccess(request, repository)).toEqual({
    collaborators: [],
    invitations: [],
  });
});
