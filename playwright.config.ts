import { defineConfig, devices } from "@playwright/test";
import { READY_LINE, WEB_URL } from "./apps/web/e2e/support/ports.ts";

export default defineConfig({
  testDir: "apps/web/e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  // One dev server, with one local queue and one SQLite file, serves every worker. Beyond a few
  // workers the tests only wait on it, and long journeys drift toward their timeouts.
  workers: process.env.CI ? 2 : 4,
  // Journeys that wait on queued work set their own, longer timeouts.
  timeout: 60_000,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Always a fresh server and database: never reuse a developer's running instance. The ready
    // line comes after serve.ts has warmed the dev server up.
    command: "node apps/web/e2e/support/serve.ts",
    wait: { stdout: new RegExp(READY_LINE) },
    reuseExistingServer: false,
    timeout: 180_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 5_000 },
  },
});
