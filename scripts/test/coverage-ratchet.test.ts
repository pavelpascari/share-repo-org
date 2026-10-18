import { describe, expect, it } from "vitest";
import {
  findDecreases,
  findRegressions,
  findUncommittedGains,
  floorToTenth,
  measureCoverage,
  measureMutationScore,
  parseThresholdsFile,
  raiseThresholds,
  run,
  type ThresholdsFile,
} from "../coverage-ratchet.ts";
import { memoryIo } from "./memory-io.ts";

const ROOT = "/repo";
const full = (pct: number) => ({ lines: pct, branches: pct, functions: pct, statements: pct });

function thresholds(overrides: Partial<ThresholdsFile> = {}): ThresholdsFile {
  return {
    coverage: {
      "packages/domain/src/**": full(100),
      "packages/db/src/**": full(90),
    },
    mutation: { domain: 80 },
    ...overrides,
  };
}

const metric = (covered: number, total: number) => ({
  covered,
  total,
  skipped: 0,
  pct: total === 0 ? 100 : (covered / total) * 100,
});
const fileSummary = (covered: number, total: number) => ({
  lines: metric(covered, total),
  branches: metric(covered, total),
  functions: metric(covered, total),
  statements: metric(covered, total),
});

describe("floorToTenth", () => {
  it("rounds down to one decimal using exact integer arithmetic", () => {
    expect(floorToTenth(1, 3)).toBe(33.3);
    expect(floorToTenth(2, 3)).toBe(66.6);
    expect(floorToTenth(9015, 10000)).toBe(90.1);
    expect(floorToTenth(10, 10)).toBe(100);
    expect(floorToTenth(0, 10)).toBe(0);
  });
});

describe("parseThresholdsFile", () => {
  it("accepts a valid file and keeps a top-level comment", () => {
    const input = { $comment: "note", ...thresholds() };
    const parsed = parseThresholdsFile(input);
    expect(parsed).toEqual(input);
    expect(Object.keys(parsed)[0]).toBe("$comment");
  });

  it("rejects malformed files with a clear message", () => {
    expect(() => parseThresholdsFile(null)).toThrow(/must be a JSON object/);
    expect(() => parseThresholdsFile({ coverage: {} })).toThrow(/"mutation" must be an object/);
    expect(() => parseThresholdsFile({ coverage: [], mutation: {} })).toThrow(
      /"coverage" must be an object/,
    );
    expect(() => parseThresholdsFile({ coverage: { "a/**": { lines: 1 } }, mutation: {} })).toThrow(
      /"a\/\*\*" is missing "branches"/,
    );
    expect(() =>
      parseThresholdsFile({ coverage: { "a/**": { ...full(1), lines: 101 } }, mutation: {} }),
    ).toThrow(/between 0 and 100/);
    expect(() => parseThresholdsFile({ coverage: {}, mutation: { domain: "80" } })).toThrow(
      /mutation "domain" must be a number between 0 and 100/,
    );
    expect(() => parseThresholdsFile({ coverage: { x: 5 }, mutation: {} })).toThrow(
      /coverage scope "x" must be an object/,
    );
    expect(() => parseThresholdsFile({ ...thresholds(), extra: 1 })).toThrow(/unknown key "extra"/);
  });
});

describe("measureCoverage", () => {
  const summary = {
    total: fileSummary(0, 0),
    "/repo/packages/domain/src/a.ts": fileSummary(9, 10),
    "/repo/packages/domain/src/nested/b.ts": fileSummary(1, 2),
    "/repo/apps/web/app/root.tsx": fileSummary(0, 4),
  };

  it("aggregates covered and total counts per committed glob", () => {
    const measured = measureCoverage(summary, thresholds(), ROOT);
    expect(measured["packages/domain/src/**"]).toEqual(full(83.3));
  });

  it("omits globs that match no files, so empty packages are never ratcheted", () => {
    const measured = measureCoverage(summary, thresholds(), ROOT);
    expect(Object.keys(measured)).toEqual(["packages/domain/src/**"]);
  });

  it("omits a metric with no countable items instead of treating it as 100%", () => {
    const measured = measureCoverage(
      {
        "/repo/packages/db/src/x.ts": {
          ...fileSummary(3, 3),
          branches: metric(0, 0),
        },
      },
      thresholds(),
      ROOT,
    );
    expect(measured["packages/db/src/**"]).toEqual({ lines: 100, functions: 100, statements: 100 });
  });

  it("rejects a summary that is not an object of file metrics", () => {
    expect(() => measureCoverage([], thresholds(), ROOT)).toThrow(/coverage summary/);
    expect(() =>
      measureCoverage({ "/repo/packages/db/src/x.ts": { lines: {} } }, thresholds(), ROOT),
    ).toThrow(/packages\/db\/src\/x\.ts/);
  });
});

describe("measureMutationScore", () => {
  const mutants = (...statuses: string[]) => statuses.map((status, id) => ({ id, status }));

  it("computes detected / valid, excluding errors and ignored mutants", () => {
    const report = {
      files: {
        "src/a.ts": { mutants: mutants("Killed", "Timeout", "Survived", "CompileError") },
        "src/b.ts": { mutants: mutants("NoCoverage", "Ignored", "RuntimeError", "Killed") },
      },
    };
    expect(measureMutationScore(report)).toBe(60);
  });

  it("returns undefined when there are no valid mutants", () => {
    expect(measureMutationScore({ files: {} })).toBeUndefined();
    expect(measureMutationScore({ files: { a: { mutants: mutants("Ignored") } } })).toBeUndefined();
  });

  it("rejects reports without a files map", () => {
    expect(() => measureMutationScore({})).toThrow(/mutation report/);
    expect(() => measureMutationScore({ files: { a: {} } })).toThrow(/mutation report/);
  });
});

describe("raiseThresholds", () => {
  it("raises thresholds to measured values and never lowers them", () => {
    const { next, changes } = raiseThresholds(thresholds(), {
      coverage: {
        "packages/domain/src/**": full(95),
        "packages/db/src/**": { lines: 93.4, branches: 90, functions: 89, statements: 92.1 },
      },
      mutation: { domain: 85.5 },
    });
    expect(next.coverage["packages/domain/src/**"]).toEqual(full(100));
    expect(next.coverage["packages/db/src/**"]).toEqual({
      lines: 93.4,
      branches: 90,
      functions: 90,
      statements: 92.1,
    });
    expect(next.mutation.domain).toBe(85.5);
    expect(changes).toEqual([
      { scope: "packages/db/src/**", metric: "lines", from: 90, to: 93.4 },
      { scope: "packages/db/src/**", metric: "statements", from: 90, to: 92.1 },
      { scope: "domain", metric: "mutation", from: 80, to: 85.5 },
    ]);
  });

  it("ignores measurements for scopes that are not committed", () => {
    const { next, changes } = raiseThresholds(thresholds(), {
      coverage: { "unknown/**": full(100) },
      mutation: { other: 99 },
    });
    expect(next).toEqual(thresholds());
    expect(changes).toEqual([]);
  });

  it("does not mutate the input", () => {
    const input = thresholds();
    raiseThresholds(input, { coverage: { "packages/db/src/**": full(99) }, mutation: {} });
    expect(input).toEqual(thresholds());
  });
});

describe("findDecreases", () => {
  it("reports thresholds lowered against the base", () => {
    const current = thresholds();
    current.coverage["packages/db/src/**"] = { ...full(90), branches: 89.9 };
    current.mutation.domain = 79;
    expect(findDecreases(thresholds(), current)).toEqual([
      { scope: "packages/db/src/**", metric: "branches", from: 90, to: 89.9 },
      { scope: "domain", metric: "mutation", from: 80, to: 79 },
    ]);
  });

  it("treats a removed scope as a decrease to zero", () => {
    const current = thresholds({ coverage: { "packages/domain/src/**": full(100) }, mutation: {} });
    expect(findDecreases(thresholds(), current)).toEqual([
      { scope: "packages/db/src/**", metric: "lines", from: 90, to: 0 },
      { scope: "packages/db/src/**", metric: "branches", from: 90, to: 0 },
      { scope: "packages/db/src/**", metric: "functions", from: 90, to: 0 },
      { scope: "packages/db/src/**", metric: "statements", from: 90, to: 0 },
      { scope: "domain", metric: "mutation", from: 80, to: 0 },
    ]);
  });

  it("allows raised and new thresholds", () => {
    const current = thresholds();
    current.coverage["apps/jobs/src/**"] = full(90);
    current.coverage["packages/db/src/**"] = full(95);
    expect(findDecreases(thresholds(), current)).toEqual([]);
  });
});

describe("findRegressions and findUncommittedGains", () => {
  const measured = {
    coverage: { "packages/db/src/**": { ...full(90), lines: 89.9, branches: 90.1 } },
    mutation: { domain: 80 },
  };

  it("reports measured coverage below the committed threshold", () => {
    expect(findRegressions(thresholds(), measured)).toEqual([
      { scope: "packages/db/src/**", metric: "lines", from: 90, to: 89.9 },
    ]);
  });

  it("reports gains larger than the rounding margin that were not committed", () => {
    expect(findUncommittedGains(thresholds(), measured)).toEqual([
      { scope: "packages/db/src/**", metric: "branches", from: 90, to: 90.1 },
    ]);
  });

  it("ignores scopes that were not measured", () => {
    expect(findRegressions(thresholds(), { coverage: {}, mutation: {} })).toEqual([]);
    expect(findUncommittedGains(thresholds(), { coverage: {}, mutation: {} })).toEqual([]);
  });

  it("checks the mutation score too", () => {
    const m = { coverage: {}, mutation: { domain: 79.9 } };
    expect(findRegressions(thresholds(), m)).toEqual([
      { scope: "domain", metric: "mutation", from: 80, to: 79.9 },
    ]);
    const g = { coverage: {}, mutation: { domain: 81 } };
    expect(findUncommittedGains(thresholds(), g)).toEqual([
      { scope: "domain", metric: "mutation", from: 80, to: 81 },
    ]);
  });
});

describe("run", () => {
  const summaryJson = (covered: number) =>
    JSON.stringify({
      total: fileSummary(covered, 10),
      "/repo/packages/db/src/x.ts": fileSummary(covered, 10),
    });
  const files = (extra: Record<string, string> = {}) => ({
    "/repo/coverage-thresholds.json": `${JSON.stringify(thresholds(), null, 2)}\n`,
    ...extra,
  });

  it("prints usage and exits 2 for an unknown command", () => {
    const io = memoryIo(ROOT, files());
    expect(run(["nope"], io)).toBe(2);
    expect(io.errors.join("\n")).toMatch(/Usage/);
    expect(run([], io)).toBe(2);
  });

  it("exits 2 when an input file is missing or invalid", () => {
    expect(run(["update"], memoryIo(ROOT, files()))).toBe(2);
    const io = memoryIo(ROOT, { "/repo/coverage-thresholds.json": "{" });
    expect(run(["check"], io)).toBe(2);
    expect(io.errors.join("\n")).toMatch(/coverage-thresholds\.json/);
  });

  it("update raises thresholds from the coverage summary and writes the file", () => {
    const io = memoryIo(ROOT, files({ "/repo/coverage/coverage-summary.json": summaryJson(10) }));
    expect(run(["update"], io)).toBe(0);
    const written = JSON.parse(io.files["/repo/coverage-thresholds.json"] ?? "");
    expect(written.coverage["packages/db/src/**"]).toEqual(full(100));
    expect(io.files["/repo/coverage-thresholds.json"]).toMatch(/\n$/);
    expect(io.logs.join("\n")).toMatch(/packages\/db\/src\/\*\* lines: 90 → 100/);
  });

  it("update leaves the file untouched when nothing improved", () => {
    const original = files({ "/repo/coverage/coverage-summary.json": summaryJson(9) });
    const io = memoryIo(ROOT, original);
    expect(run(["update"], io)).toBe(0);
    expect(io.writes).toEqual([]);
    expect(io.logs.join("\n")).toMatch(/already up to date/);
  });

  it("update reads a mutation report when given one, and only that", () => {
    const report = JSON.stringify({
      files: { a: { mutants: [{ status: "Killed" }, { status: "Killed" }] } },
    });
    const io = memoryIo(ROOT, files({ "/repo/m.json": report }));
    expect(run(["update", "--mutation", "m.json"], io)).toBe(0);
    const written = JSON.parse(io.files["/repo/coverage-thresholds.json"] ?? "");
    expect(written.mutation.domain).toBe(100);
    expect(written.coverage).toEqual(thresholds().coverage);
  });

  it("check passes when thresholds match measurements and nothing decreased", () => {
    const io = memoryIo(
      ROOT,
      files({
        "/repo/coverage/coverage-summary.json": summaryJson(9),
        "/repo/base.json": JSON.stringify(thresholds()),
      }),
    );
    expect(run(["check", "--base", "base.json"], io)).toBe(0);
    expect(io.logs.join("\n")).toMatch(/Coverage ratchet OK/);
  });

  it("check fails when a threshold is lowered against the base", () => {
    const lowered = thresholds();
    lowered.coverage["packages/db/src/**"] = { ...full(90), lines: 85 };
    const io = memoryIo(ROOT, {
      "/repo/coverage-thresholds.json": JSON.stringify(lowered),
      "/repo/base.json": JSON.stringify(thresholds()),
    });
    expect(run(["check", "--base", "base.json", "--coverage", "none.json"], io)).toBe(2);
    expect(run(["check", "--base", "base.json", "--no-measure"], io)).toBe(1);
    expect(io.errors.join("\n")).toMatch(/lowered.*packages\/db\/src\/\*\* lines: 90 → 85/s);
    expect(io.errors.join("\n")).toMatch(/COVERAGE_DECREASE_REASON/);
  });

  it("check accepts a lowered threshold with a coverage-decrease reason", () => {
    const lowered = thresholds();
    lowered.mutation.domain = 70;
    const io = memoryIo(
      ROOT,
      {
        "/repo/coverage-thresholds.json": JSON.stringify(lowered),
        "/repo/base.json": JSON.stringify(thresholds()),
      },
      { COVERAGE_DECREASE_REASON: "Deleted the legacy importer" },
    );
    expect(run(["check", "--base", "base.json", "--no-measure"], io)).toBe(0);
    expect(io.logs.join("\n")).toMatch(/accepted.*Deleted the legacy importer/s);
  });

  it("check ignores a blank coverage-decrease reason", () => {
    const lowered = thresholds();
    lowered.mutation.domain = 70;
    const io = memoryIo(
      ROOT,
      {
        "/repo/coverage-thresholds.json": JSON.stringify(lowered),
        "/repo/base.json": JSON.stringify(thresholds()),
      },
      { COVERAGE_DECREASE_REASON: "   " },
    );
    expect(run(["check", "--base", "base.json", "--no-measure"], io)).toBe(1);
  });

  it("check fails when measured coverage exceeds the committed threshold", () => {
    const io = memoryIo(ROOT, files({ "/repo/coverage/coverage-summary.json": summaryJson(10) }));
    expect(run(["check"], io)).toBe(1);
    expect(io.errors.join("\n")).toMatch(/not committed.*coverage:update/s);
  });

  it("check fails when measured coverage is below the committed threshold", () => {
    const io = memoryIo(ROOT, files({ "/repo/coverage/coverage-summary.json": summaryJson(8) }));
    expect(run(["check"], io)).toBe(1);
    expect(io.errors.join("\n")).toMatch(/below the committed threshold/);
  });

  it("check can verify the mutation score", () => {
    const report = JSON.stringify({
      files: { a: { mutants: [{ status: "Killed" }, { status: "Survived" }] } },
    });
    const io = memoryIo(ROOT, files({ "/repo/m.json": report }));
    expect(run(["check", "--mutation", "m.json"], io)).toBe(1);
    expect(io.errors.join("\n")).toMatch(/domain mutation: 80 → 50/);
  });

  it("supports a custom thresholds path and mutation scope", () => {
    const report = JSON.stringify({ files: { a: { mutants: [{ status: "Killed" }] } } });
    const io = memoryIo(ROOT, {
      "/repo/t.json": JSON.stringify({ coverage: {}, mutation: { core: 50 } }),
      "/repo/m.json": report,
    });
    expect(
      run(
        ["update", "--thresholds", "t.json", "--mutation", "m.json", "--mutation-scope", "core"],
        io,
      ),
    ).toBe(0);
    expect(JSON.parse(io.files["/repo/t.json"] ?? "").mutation.core).toBe(100);
  });

  it("rejects unknown flags", () => {
    const io = memoryIo(ROOT, files());
    expect(run(["check", "--bogus"], io)).toBe(2);
  });
});
