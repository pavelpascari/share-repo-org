import type { APIRequestContext, Page } from "@playwright/test";
import { expect, type GitHubAccount, newGitHubAccount } from "./journeys.ts";
import { FAKE_GITHUB_URL } from "./ports.ts";

// Selling access and driving the fake GitHub's collaborators and invitations, for the specs that
// follow access from a simulated subscription to the repository. Processing goes web -> EVENTS
// queue -> jobs Worker (an auxiliary Worker of the dev server), and the dev server runs no crons,
// so a reconciliation runs only when "Check now" hands it to the queue.

/** The access table row for one subscriber, as text, or "" when it is not listed. */
async function accessRowText(page: Page, login: string): Promise<string> {
  const row = page.getByRole("row").filter({ hasText: login });
  return (await row.count()) === 0 ? "" : ((await row.first().textContent()) ?? "");
}

/** The access table row for one subscriber and repository, reloaded until it matches. */
export async function expectAccess(
  page: Page,
  slug: string,
  login: string,
  texts: readonly string[],
) {
  await expect
    .poll(
      async () => {
        await page.goto(`/w/${slug}/access`);
        const text = await accessRowText(page, login);
        return texts.filter((expected) => !text.includes(expected));
      },
      { timeout: 20_000, message: `access row for ${login}` },
    )
    .toEqual([]);
}

/** Presses the repository's "Check now" on the access page. */
export async function checkNow(page: Page, repository: string) {
  await page
    .getByRole("listitem", { name: repository })
    .getByRole("button", { name: "Check now" })
    .click();
  await expect(page.getByRole("status")).toHaveText("Check queued.");
}

/**
 * Presses "Check now" on the repository until the subscriber's row shows every text: one check
 * normally suffices; pressing again covers a run that found the repository busy. A subscriber
 * whose row is not there yet (their purchase is still being processed) is waited for.
 */
export async function checkUntil(
  page: Page,
  slug: string,
  repository: string,
  login: string,
  texts: readonly string[],
) {
  await expect
    .poll(
      async () => {
        await page.goto(`/w/${slug}/access`);
        const text = await accessRowText(page, login);
        const missing = texts.filter((expected) => !text.includes(expected));
        // Until the subscriber has an entitlement, the page lists no repository to check.
        if (missing.length > 0 && text !== "") await checkNow(page, repository);
        return missing;
      },
      { timeout: 30_000, intervals: [1_000, 2_000], message: `access row for ${login}` },
    )
    .toEqual([]);
}

/** Creates an offer selling one repository through one simulated item. */
export async function createOffer(page: Page, slug: string, repository: string, item: string) {
  await page.goto(`/w/${slug}/offers`);
  await page.getByLabel("Name").fill("Course access");
  await page.getByText(repository).click();
  await page.getByLabel("Commercial item IDs").fill(item);
  await page.getByRole("button", { name: "Create offer" }).click();
  await expect(page.getByRole("status")).toHaveText("Created “Course access”.");
}

/** A GitHub account the fake can resolve, registered with it. */
export async function registeredAccount(request: APIRequestContext): Promise<GitHubAccount> {
  const account = newGitHubAccount();
  const registered = await request.post(`${FAKE_GITHUB_URL}/_control/users`, {
    form: { login: account.login, id: account.id },
  });
  expect(registered.ok()).toBe(true);
  return account;
}

/** Adds a simulated subscriber through the Simulator; returns their subscription's list item. */
export async function addSubscriber(
  page: Page,
  slug: string,
  login: string,
  item: string,
  start: "Trial" | "Active" = "Active",
) {
  await page.goto(`/w/${slug}/simulator`);
  await page.getByLabel("GitHub login").fill(login);
  await page.getByLabel("Commercial item IDs").fill(item);
  await page
    .getByRole("radiogroup", { name: "Start as" })
    .getByText(start, { exact: true })
    .click();
  await page.getByRole("button", { name: "Add subscriber" }).click();
  await expect(page.getByRole("status")).toHaveText(`Added ${login} as a simulated subscriber.`);
  return page.getByRole("listitem", { name: login });
}

/** Applies a Simulator action ("Activate", "Cancel now"…) to a subscriber's subscription. */
export async function simulate(page: Page, slug: string, login: string, action: string) {
  await page.goto(`/w/${slug}/simulator`);
  const subscription = page.getByRole("listitem", { name: login });
  await subscription.getByRole("button", { name: action }).click();
  await expect(page.getByRole("status")).toContainText(login);
}

// The fake GitHub's controls (e2e/support/fake-github-collaborators.ts) -------------------------

export interface RepositoryAccess {
  collaborators: { id: string; login: string; permission: string }[];
  invitations: { id: string; inviteeId: string; inviteeLogin: string; expired: boolean }[];
}

async function control(request: APIRequestContext, path: string, form?: Record<string, string>) {
  const response = await request.post(`${FAKE_GITHUB_URL}/_control${path}`, { form: form ?? {} });
  expect(response.ok(), `${path}: ${response.status()}`).toBe(true);
}

/** What GitHub lists on the repository: direct collaborators and invitations. */
export async function repositoryAccess(
  request: APIRequestContext,
  repository: string,
): Promise<RepositoryAccess> {
  const response = await request.get(`${FAKE_GITHUB_URL}/_control/repos/${repository}`);
  expect(response.ok()).toBe(true);
  return (await response.json()) as RepositoryAccess;
}

/** The creator adds a collaborator by hand on GitHub. */
export const addCollaboratorByHand = (
  request: APIRequestContext,
  repository: string,
  account: GitHubAccount,
) =>
  control(request, `/repos/${repository}/collaborators`, {
    id: account.id,
    login: account.login,
  });

/** The creator removes a collaborator by hand on GitHub. */
export const removeCollaboratorByHand = (
  request: APIRequestContext,
  repository: string,
  account: GitHubAccount,
) => control(request, `/repos/${repository}/collaborators/${account.id}/remove`);

/** The subscriber accepts their pending invitation. */
export const acceptInvitation = (
  request: APIRequestContext,
  repository: string,
  account: GitHubAccount,
) => control(request, `/repos/${repository}/invitations/by-user/${account.id}/accept`);

/** The next `operation` on the repository answers with `status` (and `retry-after` seconds). */
export const failNext = (
  request: APIRequestContext,
  repository: string,
  operation: string,
  status: number,
  retryAfterSeconds?: number,
) =>
  control(request, "/failures", {
    operation,
    status: String(status),
    repository,
    ...(retryAfterSeconds === undefined ? {} : { retry_after: String(retryAfterSeconds) }),
  });
