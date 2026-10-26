import type { Page } from "@playwright/test";
import {
  createWorkspace,
  expect,
  type GitHubAccount,
  newGitHubAccount,
  signIn,
} from "./journeys.ts";

// Connecting GitHub through the fake App, shared by the specs that need a connected creator.

/** Starts "Connect GitHub" from the workspace's Repositories page. */
export async function startConnect(page: Page, slug: string, acknowledge = true) {
  await page.goto(`/w/${slug}/repositories`);
  if (acknowledge) {
    await page.getByText("I understand that subscribers get write access").click();
  }
  await page.getByRole("button", { name: "Connect GitHub" }).click();
}

/** Completes the fake GitHub install page. */
export async function installOnFakeGitHub(
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

export async function connectedCreator(
  page: Page,
  account: GitHubAccount = newGitHubAccount(),
  workspaceName = "Creator Studio",
) {
  await signIn(page, account);
  const slug = await createWorkspace(page, workspaceName);
  await startConnect(page, slug);
  await installOnFakeGitHub(page, {
    accountId: account.id,
    login: account.login,
    repositories: "course-code, extras",
  });
  await expect(page).toHaveURL(`/w/${slug}/repositories`);
  return { account, slug };
}
