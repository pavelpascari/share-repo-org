import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// `.href` because this package's types are Workers types, whose URL differs from Node's.
const migrationsDir = fileURLToPath(new URL("../db/migrations", import.meta.url).href);

export default defineProject({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      // Same files and parser as `wrangler d1 migrations apply` (top-level *.sql only).
      miniflare: { bindings: { TEST_MIGRATIONS: await readD1Migrations(migrationsDir) } },
    })),
  ],
  test: {
    name: "application",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup/apply-migrations.ts"],
  },
});
