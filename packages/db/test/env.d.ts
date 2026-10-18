// Bindings declared in wrangler.test.jsonc and vitest.config.ts.
declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TEST_MIGRATIONS: import("cloudflare:test").D1Migration[];
  }
}
