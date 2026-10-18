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
      provider: "v8",
      // V8 rather than Istanbul: under the Workers plugin, Istanbul intermittently recorded a
      // module twice (source and transpiled positions) when it was reused across test files.
      include: [
        "packages/*/src/**/*.ts",
        "apps/*/src/**/*.ts",
        // UI routes are reported but have no line threshold: they are covered by journeys.
        "apps/web/app/**/*.{ts,tsx}",
        "apps/web/workers/**/*.ts",
        "scripts/*.ts",
      ],
      exclude: [
        // Package barrels only re-export; V8 would report them as uncovered.
        "packages/*/src/**/index.ts",
        // Framework wiring around the virtual server build, which only resolves in a real build;
        // its behaviour lives in handler.ts and the wiring itself is exercised by E2E.
        "apps/web/workers/app.ts",
      ],
      reporter: ["text-summary", "html", "json-summary"],
      // Globs that match no files (packages without source yet) pass trivially.
      thresholds: { ...ratchet.coverage },
    },
  },
});
