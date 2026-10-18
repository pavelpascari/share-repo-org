import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

describe("application test environment", () => {
  it("has a migrated D1 database", async () => {
    const row = await env.DB.prepare("SELECT count(*) AS n FROM d1_migrations").first<{
      n: number;
    }>();
    expect(row?.n).toBeGreaterThanOrEqual(2);
  });
});
