import {
  createWorkspace,
  expect,
  newGitHubAccount,
  signIn,
  test,
  uniqueSlug,
} from "./support/journeys.ts";

test("workspace form shows field errors and keeps the input", async ({ page }) => {
  await signIn(page, newGitHubAccount());
  await page.goto("/workspaces/new");
  await page.getByLabel("Name").fill("Acme");
  await page.getByLabel("URL").fill("Not A Slug");
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText("Use lowercase letters, numbers and single hyphens.")).toBeVisible();
  await expect(page.getByLabel("Name")).toHaveValue("Acme");
});

test("a taken workspace URL is reported", async ({ page }) => {
  await signIn(page, newGitHubAccount());
  const slug = await createWorkspace(page, "First");
  await page.goto("/workspaces/new");
  await page.getByLabel("Name").fill("Second");
  await page.getByLabel("URL").fill(slug);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page.getByText("This URL is already taken.")).toBeVisible();
});

test("an owner renames the workspace in settings", async ({ page }) => {
  await signIn(page, newGitHubAccount());
  const slug = await createWorkspace(page, "Old Name");
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByLabel("Workspace name").fill("New Name");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("status")).toHaveText("Saved.");
  await page.goto(`/w/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name: "New Name" })).toBeVisible();
});

test("signed-out visitors are sent home from workspace pages", async ({ page }) => {
  await page.goto(`/w/${uniqueSlug()}`);
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
});
