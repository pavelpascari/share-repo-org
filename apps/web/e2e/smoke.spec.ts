import { expect, test } from "@playwright/test";

test("home page renders", async ({ page }) => {
  const response = await page.goto("/");
  expect(response?.status()).toBe(200);
  expect(response?.headers()["x-request-id"]).toBeTruthy();
  await expect(page.getByRole("heading", { level: 1, name: "ShareRepo" })).toBeVisible();
});

test("unknown pages render the not-found boundary", async ({ page }) => {
  const response = await page.goto("/does-not-exist");
  expect(response?.status()).toBe(404);
  await expect(page.getByRole("heading", { name: "Page not found" })).toBeVisible();
});

test("readiness reports D1 through the application boundary", async ({ request }) => {
  const response = await request.get("/readyz");
  expect(response.status()).toBe(200);
  expect(await response.json()).toEqual({ status: "ready", checks: { d1: "ok" } });
});

test("the web Worker assigns its own request ID, ignoring the client's", async ({ request }) => {
  const response = await request.get("/healthz", {
    headers: { "x-request-id": "e2e-request-0001" },
  });
  expect(response.headers()["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
});
