import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs before each test file. D1 storage is isolated per file, and applying is idempotent
// (applied names are recorded in `d1_migrations`).
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
