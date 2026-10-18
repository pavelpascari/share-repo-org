import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";

// Committed per-package thresholds. Raised by `scripts/coverage-ratchet.ts update`, not by
// Vitest's autoUpdate, which can only rewrite literals in this file. See decision 0005.
const ratchet: { coverage: Record<string, Record<string, number>> } = JSON.parse(
  readFileSync(new URL("./coverage-thresholds.json", import.meta.url), "utf8"),
);

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
        // UI routes are reported but have no line threshold: they are covered by journeys.
        "apps/web/app/**",
        "apps/web/workers/**",
        "scripts/*.ts",
      ],
      reporter: ["text-summary", "html", "json-summary"],
      // Globs that match no files (packages without source yet) pass trivially.
      thresholds: { ...ratchet.coverage },
    },
  },
});
