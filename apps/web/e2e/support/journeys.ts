import { randomInt } from "node:crypto";
import { test as base, expect, type Page } from "@playwright/test";

export interface GitHubAccount {
  id: string;
  login: string;
  name?: string;
}

/** A GitHub account unique to this test run: D1 persists across the tests of one run. */
export function newGitHubAccount(): GitHubAccount {
  const id = String(randomInt(1, 2 ** 31));
  return { id, login: `octo-${id}`, name: `Octo ${id}` };
}

export function uniqueSlug(): string {
  return `ws-${randomInt(1, 2 ** 40).toString(36)}`;
}

/**
 * Each test gets its own client IP: sign-in is rate limited per IP (decision 0006), and Cloudflare
 * sets this header in production, so tests never share a bucket.
 */
export const test = base.extend({
  context: async ({ context }, use) => {
    await context.setExtraHTTPHeaders({
      "cf-connecting-ip": `198.51.${randomInt(0, 256)}.${randomInt(1, 255)}`,
    });
    await use(context);
  },
});

/** Signs in through ShareRepo's button and the fake GitHub's authorize page. */
export async function signIn(page: Page, account: GitHubAccount): Promise<void> {
  await page.goto("/");
  await page.getByRole("button", { name: "Sign in with GitHub" }).click();
  await expect(page.getByRole("heading", { name: "Authorize ShareRepo" })).toBeVisible();
  await page.getByLabel("GitHub ID").fill(account.id);
  await page.getByLabel("Login").fill(account.login);
  await page.getByLabel("Name").fill(account.name ?? "");
  await page.getByRole("button", { name: "Authorize" }).click();
  await expect(page.getByRole("button", { name: "Sign out" }).first()).toBeVisible();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Sign out" }).first().click();
  await expect(page.getByRole("button", { name: "Sign in with GitHub" })).toBeVisible();
}

export async function createWorkspace(page: Page, name: string, slug = uniqueSlug()) {
  await page.goto("/workspaces/new");
  await page.getByLabel("Name").fill(name);
  await page.getByLabel("URL").fill(slug);
  await page.getByRole("button", { name: "Create workspace" }).click();
  await expect(page).toHaveURL(`/w/${slug}`);
  await expect(page.getByRole("heading", { level: 1, name })).toBeVisible();
  return slug;
}

export { expect };
