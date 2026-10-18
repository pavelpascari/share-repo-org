import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineProject } from "vitest/config";

// Workers runtime, so WebCrypto, fetch and Request behave as in production.
export default defineProject({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.test.jsonc" } })],
  test: {
    name: "integrations",
    include: ["test/**/*.test.ts"],
  },
});
