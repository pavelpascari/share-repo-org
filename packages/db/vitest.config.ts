import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// `.href` because this package's types are Workers types, whose URL differs from Node's.
const migrationsDir = fileURLToPath(new URL("./migrations", import.meta.url).href);
const fixturesDir = fileURLToPath(new URL("./test/fixtures", import.meta.url).href);

// Upgrade fixtures (`at-NNNN.sql`) by file name, for `test/upgrade.test.ts`.
const upgradeFixtures = Object.fromEntries(
  readdirSync(fixturesDir)
    .filter((name) => /^at-\d{4}\.sql$/.test(name))
    .map((name) => [name, readFileSync(join(fixturesDir, name), "utf8")]),
);

export default defineProject({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.test.jsonc" },
      // Same files and parser as `wrangler d1 migrations apply` (top-level *.sql only).
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(migrationsDir),
          UPGRADE_FIXTURES: upgradeFixtures,
        },
      },
    })),
  ],
  test: {
    name: "db",
    include: ["test/**/*.test.ts"],
    setupFiles: ["./test/setup/apply-migrations.ts"],
  },
});
