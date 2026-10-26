// @ts-check
// Mutation testing for the domain package (docs/testing-strategy.md § Coverage policy).
// The break threshold is the committed, ratcheted `mutation.domain` value.
import { readFileSync } from "node:fs";

const ratchet = JSON.parse(
  readFileSync(new URL("../../coverage-thresholds.json", import.meta.url), "utf8"),
);

/** @type {import("@stryker-mutator/api/core").PartialStrykerOptions} */
export default {
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  // The runner forces Vitest's threads pool, which this Node project supports.
  vitest: { configFile: "vitest.config.ts" },
  mutate: ["src/**/*.ts"],
  coverageAnalysis: "perTest",
  reporters: ["clear-text", "progress", "html", "json"],
  // List only the score table and surviving mutants. The per-test list marks every test that
  // killed no mutant with ✘, which reads as a failure in CI logs although it is not one.
  clearTextReporter: { reportTests: false },
  jsonReporter: { fileName: "reports/mutation/mutation.json" },
  htmlReporter: { fileName: "reports/mutation/mutation.html" },
  thresholds: { high: 100, low: 90, break: ratchet.mutation.domain },
  tempDirName: ".stryker-tmp",
};
