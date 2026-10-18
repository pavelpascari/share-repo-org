import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      "packages/*/vitest.config.ts",
      "apps/*/vitest.config.ts",
      "scripts/vitest.config.ts",
    ],
    coverage: {
      provider: "istanbul",
      include: [
        "packages/*/src/**",
        "apps/*/src/**",
        "apps/web/app/**",
        "apps/web/workers/**",
        "scripts/*.ts",
      ],
      reporter: ["text-summary", "html", "json-summary"],
    },
  },
});
