import {
  createWorkspace,
  expect,
  newGitHubAccount,
  signIn,
  test,
  uniqueSlug,
} from "./support/journeys.ts";

test("isolation/cross-workspace-read-denied: another user's workspace is not found", async ({
  browser,
}) => {
  const alice = await browser.newContext();
  const alicePage = await alice.newPage();
  await signIn(alicePage, newGitHubAccount());
  const slug = await createWorkspace(alicePage, "Alice Private");

  const bob = await browser.newContext();
  const bobPage = await bob.newPage();
  await signIn(bobPage, newGitHubAccount());
  for (const path of [`/w/${slug}`, `/w/${slug}/settings`]) {
    const response = await bobPage.goto(path);
    expect(response?.status()).toBe(404);
    await expect(bobPage.getByRole("heading", { name: "Page not found" })).toBeVisible();
    await expect(bobPage.getByText("Alice Private")).toHaveCount(0);
  }

  const rename = await bobPage.request.post(`/w/${slug}/settings`, {
    form: { name: "Pwned" },
    headers: { origin: new URL(bobPage.url()).origin },
  });
  expect(rename.status()).toBe(404);
  await alicePage.reload();
  await expect(alicePage.getByRole("heading", { level: 1, name: "Alice Private" })).toBeVisible();
  await Promise.all([alice.close(), bob.close()]);
});

test("cross-origin form posts are refused and change nothing", async ({ page }) => {
  await signIn(page, newGitHubAccount());
  const slug = uniqueSlug();
  const response = await page.request.post("/workspaces/new", {
    form: { name: "CSRF", slug },
    headers: { origin: "https://evil.example" },
    maxRedirects: 0,
  });
  // React Router refuses cross-origin actions itself (400); ours would answer 403.
  expect([400, 403]).toContain(response.status());
  expect((await page.goto(`/w/${slug}`))?.status()).toBe(404);
});
