import {
  createWorkspace,
  expect,
  newGitHubAccount,
  signIn,
  signOut,
  test,
} from "./support/journeys.ts";
import { FAKE_GITHUB_URL } from "./support/ports.ts";

test("sign in, create a workspace, sign out, and come back to it", async ({ page }) => {
  const account = newGitHubAccount();
  await signIn(page, account);
  await expect(page.getByText("You have no workspaces yet.")).toBeVisible();

  const slug = await createWorkspace(page, "Acme Labs");
  await expect(page.getByText("You are an owner of this workspace.")).toBeVisible();

  // While signed in, home returns to the last workspace.
  await page.goto("/");
  await expect(page).toHaveURL(`/w/${slug}`);

  // Sign-out forgets it (shared browsers); after signing in again the workspace is listed.
  await signOut(page);
  await signIn(page, account);
  await page.getByRole("link", { name: "Acme Labs" }).click();
  await expect(page).toHaveURL(`/w/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name: "Acme Labs" })).toBeVisible();
});

test("identity/username-change-keeps-identity: a renamed GitHub user keeps their account", async ({
  page,
}) => {
  const account = newGitHubAccount();
  await signIn(page, account);
  const slug = await createWorkspace(page, "Before Rename");
  await signOut(page);

  await signIn(page, { ...account, login: `${account.login}-renamed` });
  await page.getByRole("link", { name: "Before Rename" }).click();
  await expect(page).toHaveURL(`/w/${slug}`);
});

test("a cancelled GitHub authorization shows a sign-in error", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await page.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("alert")).toHaveText("Sign-in failed. Please try again.");
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
});

test("signing in never touches GitHub App installation endpoints", async ({ page, request }) => {
  await signIn(page, newGitHubAccount());
  await createWorkspace(page, "No Installations");
  const calls: string[] = await (await request.get(`${FAKE_GITHUB_URL}/_control/calls`)).json();
  const allowed = new Set([
    "GET /login/oauth/authorize",
    "POST /login/oauth/authorize",
    "POST /login/oauth/access_token",
    "GET /api/user",
  ]);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.filter((call) => !allowed.has(call))).toEqual([]);
});
