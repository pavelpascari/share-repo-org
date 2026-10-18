import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// `.href` because this package's types are Workers types, whose URL differs from Node's.
const migrationsDir = fileURLToPath(new URL("../../packages/db/migrations", import.meta.url).href);

export default defineProject({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir) } },
    })),
  ],
  test: {
    name: "jobs",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup/apply-migrations.ts"],
  },
});
