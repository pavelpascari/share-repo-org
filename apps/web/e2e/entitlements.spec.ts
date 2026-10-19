import type { Page } from "@playwright/test";
import { connectedCreator } from "./support/github.ts";
import { expect, newGitHubAccount, test } from "./support/journeys.ts";
import { FAKE_GITHUB_URL } from "./support/ports.ts";

// Phase 3 journeys: offers, the simulated billing source, and the access view. Processing goes
// web -> EVENTS queue -> jobs Worker (an auxiliary Worker of the dev server), so the access view
// is polled.

/** The access table row for one subscriber and repository, reloaded until it matches. */
async function expectAccess(page: Page, slug: string, login: string, texts: readonly string[]) {
  await expect
    .poll(
      async () => {
        await page.goto(`/w/${slug}/access`);
        const row = page.getByRole("row").filter({ hasText: login });
        const text = (await row.count()) === 0 ? "" : ((await row.first().textContent()) ?? "");
        return texts.filter((expected) => !text.includes(expected));
      },
      { timeout: 20_000, message: `access row for ${login}` },
    )
    .toEqual([]);
}

test("an owner sells a repository to a simulated subscriber, then cancels", async ({
  page,
  request,
}) => {
  const { account, slug } = await connectedCreator(page);

  // An offer for one repository, sold through the simulated item sim_monthly.
  await page.goto(`/w/${slug}/offers`);
  await expect(page.getByRole("heading", { level: 1, name: "Offers" })).toBeVisible();
  await page.getByLabel("Name").fill("Course access");
  await expect(page.getByLabel("Grace period (days)")).toHaveValue("7");
  await page.getByText(`${account.login}/course-code`).click();
  await page.getByLabel("Commercial item IDs").fill("sim_monthly");
  await page.getByRole("button", { name: "Create offer" }).click();
  await expect(page.getByRole("status")).toHaveText("Created “Course access”.");
  const offer = page.getByRole("listitem", { name: "Course access" });
  await expect(offer).toContainText("version 1");
  await expect(offer).toContainText(`${account.login}/course-code (write access)`);
  await expect(offer).toContainText("sim_monthly");

  // A GitHub account the fake can resolve, added as a simulated subscriber on a trial.
  const subscriber = newGitHubAccount();
  const registered = await request.post(`${FAKE_GITHUB_URL}/_control/users`, {
    form: { login: subscriber.login, id: subscriber.id },
  });
  expect(registered.ok()).toBe(true);
  await page.goto(`/w/${slug}/simulator`);
  await expect(page.getByText("Simulated billing for testing.")).toBeVisible();
  await page.getByLabel("GitHub login").fill(subscriber.login);
  await page.getByLabel("Commercial item IDs").fill("sim_monthly");
  await page.getByText("Trial", { exact: true }).click();
  await page.getByRole("button", { name: "Add subscriber" }).click();
  await expect(page.getByRole("status")).toHaveText(
    `Added ${subscriber.login} as a simulated subscriber.`,
  );
  const subscription = page.getByRole("listitem", { name: subscriber.login });
  await expect(subscription).toContainText("Trialing");
  await subscription.getByRole("button", { name: "Activate" }).click();
  await expect(subscription).toContainText("Active");

  await expectAccess(page, slug, subscriber.login, [
    `${account.login}/course-code`,
    "Active",
    "Subscription active",
    "Course access, version 1",
    "Not checked yet",
    "Will invite",
  ]);
  // Repository-centric copy (phase-3 plan § Creator views).
  await expect(page.getByRole("columnheader", { name: "Subscriber" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Repository" })).toBeVisible();
  await expect(page.getByText(/resource|subject/i)).toHaveCount(0);

  await page.goto(`/w/${slug}/simulator`);
  await subscription.getByRole("button", { name: "Cancel now" }).click();
  await expect(subscription).toContainText("Canceled");
  await expectAccess(page, slug, subscriber.login, ["Ended", "Subscription canceled"]);
});

test("archiving an offer asks for confirmation in the page", async ({ page }) => {
  const { account, slug } = await connectedCreator(page);
  await page.goto(`/w/${slug}/offers`);
  await page.getByLabel("Name").fill("Old offer");
  await page.getByText(`${account.login}/extras`).click();
  await page.getByRole("button", { name: "Create offer" }).click();
  const offer = page.getByRole("listitem", { name: "Old offer" });
  await offer.getByRole("button", { name: "Archive" }).click();
  const dialog = page.getByRole("alertdialog", { name: "Archive “Old offer”?" });
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Keep offer" }).click();
  await expect(dialog).toBeHidden();
  await expect(offer).toContainText("Active");

  await offer.getByRole("button", { name: "Archive" }).click();
  await dialog.getByRole("button", { name: "Archive offer" }).click();
  await expect(page.getByRole("status")).toHaveText("Archived “Old offer”.");
  await expect(offer).toContainText("Archived · version 2");
  await expect(offer.getByRole("button", { name: "Archive" })).toHaveCount(0);
});
