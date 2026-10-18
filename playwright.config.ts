import { defineConfig, devices } from "@playwright/test";
import { WEB_URL } from "./apps/web/e2e/support/ports.ts";

export default defineConfig({
  testDir: "apps/web/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Always a fresh server and database: never reuse a developer's running instance.
    command: "node apps/web/e2e/support/serve.ts",
    url: `${WEB_URL}/readyz`,
    reuseExistingServer: false,
    timeout: 120_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
