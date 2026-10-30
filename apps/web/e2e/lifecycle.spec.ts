import { readFile } from "node:fs/promises";
import { createWorkspace, expect, newGitHubAccount, signIn, test } from "./support/journeys.ts";

// The data lifecycle (decision 0015) in the browser: export, workspace deletion and its
// cancellation, and account deletion.

test("an owner exports the workspace as a JSON file", async ({ page }) => {
  await signIn(page, newGitHubAccount());
  const slug = await createWorkspace(page, "Exported");
  await page.getByRole("link", { name: "Settings" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download export" }).click();
  const file = await download;
  expect(file.suggestedFilename()).toMatch(new RegExp(`^sharerepo-${slug}-.*\\.json$`));
  const document = JSON.parse(await readFile((await file.path()) as string, "utf8")) as {
    formatVersion: number;
    workspace: { slug: string; name: string };
  };
  expect(document.formatVersion).toBe(2);
  expect(document.workspace).toEqual(expect.objectContaining({ slug, name: "Exported" }));
});

test("an owner deletes the workspace, then cancels the deletion", async ({ page }) => {
  await signIn(page, newGitHubAccount());
  const slug = await createWorkspace(page, "Doomed");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel(`Type ${slug} to confirm`).fill("not-it");
  await page.getByRole("button", { name: "Delete workspace" }).click();
  await expect(page.getByText("Type the workspace's URL name exactly to confirm.")).toBeVisible();

  await page.getByLabel(`Type ${slug} to confirm`).fill(slug);
  await page.getByRole("button", { name: "Delete workspace" }).click();
  await expect(
    page.getByText(/This workspace is being deleted\. Its data will be deleted after/),
  ).toBeVisible();
  await expect(
    page.getByText("uninstall the ShareRepo GitHub App", { exact: false }),
  ).toBeVisible();
  await page.goto(`/w/${slug}`);
  await expect(page.getByText("This workspace is being deleted and is read-only.")).toBeVisible();

  await page.goto(`/w/${slug}/settings`);
  await page.getByRole("button", { name: "Cancel deletion" }).click();
  await expect(page.getByLabel("Workspace name")).toHaveValue("Doomed");
  await expect(page.getByRole("button", { name: "Delete workspace" })).toBeVisible();
});

test("a user deletes their account once they own no workspace", async ({ page }) => {
  const account = newGitHubAccount();
  await signIn(page, account);
  const slug = await createWorkspace(page, "Owned");
  await page.getByRole("link", { name: "Account" }).click();
  await expect(page.getByText("You own these workspaces. Delete them first:")).toBeVisible();
  await page.getByRole("link", { name: "Owned" }).click();
  await page.getByLabel(`Type ${slug} to confirm`).fill(slug);
  await page.getByRole("button", { name: "Delete workspace" }).click();
  await expect(page.getByText(/This workspace is being deleted/).first()).toBeVisible();

  await page.getByRole("link", { name: "Account" }).click();
  await page.getByLabel(`Type ${account.login} to confirm`).fill(account.login);
  await page.getByRole("button", { name: "Delete my account" }).click();
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
  // Signed out for good: the old session no longer opens a page.
  await page.goto("/me");
  await expect(page).toHaveURL("/");
});
