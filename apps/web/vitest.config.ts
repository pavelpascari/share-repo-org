import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// `.href` because this package's types are Workers types, whose URL differs from Node's.
const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url).href);

export default defineProject({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
          // Test-only values for the secrets declared in wrangler.jsonc.
          BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123456789",
          GITHUB_CLIENT_SECRET: "test-github-client-secret",
        },
      },
    })),
  ],
  test: {
    name: "web",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup/apply-migrations.ts"],
  },
});
