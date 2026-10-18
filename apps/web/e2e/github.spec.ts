import type { Page } from "@playwright/test";
import {
  createWorkspace,
  expect,
  type GitHubAccount,
  newGitHubAccount,
  signIn,
  test,
} from "./support/journeys.ts";
import { FAKE_GITHUB_URL } from "./support/ports.ts";

/** Starts "Connect GitHub" from the workspace's Repositories page. */
async function startConnect(page: Page, slug: string, acknowledge = true) {
  await page.goto(`/w/${slug}/repositories`);
  if (acknowledge) {
    await page.getByText("I understand that subscribers get write access").click();
  }
  await page.getByRole("button", { name: "Connect GitHub" }).click();
}

/** Completes the fake GitHub install page. */
async function installOnFakeGitHub(
  page: Page,
  input: { accountId: string; login: string; type?: "User" | "Organization"; repositories: string },
) {
  await expect(page.getByRole("heading", { name: "Install ShareRepo" })).toBeVisible();
  await page.getByLabel("Account ID").fill(input.accountId);
  await page.getByLabel("Account login").fill(input.login);
  await page.getByLabel("Account type").selectOption(input.type ?? "User");
  await page.getByLabel("Repositories").fill(input.repositories);
  await page.getByRole("button", { name: "Install" }).click();
}

async function connectedCreator(page: Page, account: GitHubAccount = newGitHubAccount()) {
  await signIn(page, account);
  const slug = await createWorkspace(page, "Creator Studio");
  await startConnect(page, slug);
  await installOnFakeGitHub(page, {
    accountId: account.id,
    login: account.login,
    repositories: "course-code, extras",
  });
  await expect(page).toHaveURL(`/w/${slug}/repositories`);
  return { account, slug };
}

test("an owner connects GitHub and sees the selected repositories", async ({ page }) => {
  const { account } = await connectedCreator(page);
  await expect(page.getByRole("heading", { name: `GitHub: ${account.login}` })).toBeVisible();
  for (const name of ["course-code", "extras"]) {
    const row = page.getByRole("listitem").filter({ hasText: `${account.login}/${name}` });
    await expect(row).toContainText("Ready to sell");
  }
});

test("connecting requires acknowledging write access", async ({ page }) => {
  await signIn(page, newGitHubAccount());
  const slug = await createWorkspace(page, "No Ack");
  await startConnect(page, slug, false);
  await expect(page.getByRole("alert")).toHaveText(
    "Confirm that subscribers will get write access.",
  );
});

test("connection/install-callback-bound-to-intent: a replayed setup link attaches nothing", async ({
  page,
}) => {
  const account = newGitHubAccount();
  await signIn(page, account);
  const slug = await createWorkspace(page, "Replay");
  await startConnect(page, slug);
  const setup = page.waitForRequest((request) => request.url().includes("/github/setup"));
  await installOnFakeGitHub(page, {
    accountId: account.id,
    login: account.login,
    repositories: "course-code",
  });
  const setupUrl = (await setup).url();
  await expect(page).toHaveURL(`/w/${slug}/repositories`);

  await page.goto(setupUrl);
  await expect(page.getByRole("alert")).toContainText("expired or was already used");
});

test("an organization installation is refused (personal accounts only)", async ({ page }) => {
  const account = newGitHubAccount();
  await signIn(page, account);
  const slug = await createWorkspace(page, "Org Attempt");
  await startConnect(page, slug);
  await installOnFakeGitHub(page, {
    accountId: "777000",
    login: "acme-org",
    type: "Organization",
    repositories: "private-lib",
  });
  await expect(page.getByRole("alert")).toContainText("personal GitHub accounts only");
  await page.goto(`/w/${slug}/repositories`);
  await expect(page.getByRole("button", { name: "Connect GitHub" })).toBeVisible();
});

test("an installation on someone else's account is refused", async ({ page }) => {
  const account = newGitHubAccount();
  await signIn(page, account);
  const slug = await createWorkspace(page, "Wrong Account");
  await startConnect(page, slug);
  await installOnFakeGitHub(page, {
    accountId: String(Number(account.id) + 1),
    login: "someone-else",
    repositories: "theirs",
  });
  await expect(page.getByRole("alert")).toContainText("the GitHub account you signed in with");
});

test("a repository removed on GitHub is marked removed after the webhook is processed", async ({
  page,
  request,
}) => {
  const { account, slug } = await connectedCreator(page);
  const removed = await request.post(
    `${FAKE_GITHUB_URL}/_control/installations/by-login/${account.login}/remove-repository`,
    { form: { name: "extras" } },
  );
  expect(removed.ok()).toBe(true);
  // The webhook reaches the jobs Worker through the EVENTS queue, which resyncs from GitHub.
  await expect
    .poll(
      async () => {
        await page.goto(`/w/${slug}/repositories`);
        return page
          .getByRole("listitem")
          .filter({ hasText: `${account.login}/extras` })
          .textContent();
      },
      { timeout: 20_000 },
    )
    .toContain("Removed from the App");
  await expect(
    page.getByRole("listitem").filter({ hasText: `${account.login}/course-code` }),
  ).toContainText("Ready to sell");
});
