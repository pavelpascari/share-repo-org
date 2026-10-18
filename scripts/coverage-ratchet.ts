// Coverage ratchet (docs/decisions/0005-coverage-ratchet.md).
//
//   node scripts/coverage-ratchet.ts update [options]
//     Raise committed thresholds to measured values (rounded down to 0.1). Never lowers.
//   node scripts/coverage-ratchet.ts check [--base <file>] [options]
//     Fail if a threshold is lower than in <file> (unless COVERAGE_DECREASE_REASON is set),
//     if measured coverage is below a threshold, or if a gain was not committed.
//
// Options:
//   --thresholds <file>      committed thresholds (default coverage-thresholds.json)
//   --coverage <file>        Istanbul json-summary (default coverage/coverage-summary.json)
//   --mutation <file>        Stryker JSON report; when given without --coverage, only the
//                            mutation score is measured
//   --mutation-scope <name>  key under "mutation" for that report (default domain)
//   --no-measure             check: compare against --base only

import { matchesGlob, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { nodeIo, type ScriptIo } from "./io.ts";

export const METRICS = ["lines", "branches", "functions", "statements"] as const;
export type Metric = (typeof METRICS)[number];
export type CoverageThresholds = Record<Metric, number>;

export interface ThresholdsFile {
  $comment?: string;
  /** Glob (relative to the repo root, as in Vitest) → thresholds for the files it matches. */
  coverage: Record<string, CoverageThresholds>;
  /** Package name → Stryker mutation score threshold. */
  mutation: Record<string, number>;
}

export interface Measurements {
  coverage: Record<string, Partial<CoverageThresholds>>;
  mutation: Record<string, number>;
}

export interface Change {
  scope: string;
  metric: Metric | "mutation";
  from: number;
  to: number;
}

export const DEFAULT_THRESHOLDS_PATH = "coverage-thresholds.json";
export const DEFAULT_SUMMARY_PATH = "coverage/coverage-summary.json";
export const DEFAULT_MUTATION_SCOPE = "domain";
export const DECREASE_REASON_ENV = "COVERAGE_DECREASE_REASON";

/** `covered / total` as a percentage rounded down to one decimal, using integer arithmetic. */
export function floorToTenth(covered: number, total: number): number {
  return Math.floor((covered * 1000) / total) / 10;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPercentage = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;

export function parseThresholdsFile(input: unknown): ThresholdsFile {
  if (!isRecord(input)) throw new Error("thresholds file must be a JSON object");
  for (const key of Object.keys(input)) {
    if (!["$comment", "coverage", "mutation"].includes(key)) {
      throw new Error(`thresholds file has unknown key "${key}"`);
    }
  }
  const { $comment, coverage, mutation } = input;
  if (!isRecord(coverage)) throw new Error('thresholds file: "coverage" must be an object');
  if (!isRecord(mutation)) throw new Error('thresholds file: "mutation" must be an object');

  // Keep the comment first so rewritten files stay readable.
  const result: ThresholdsFile =
    typeof $comment === "string"
      ? { $comment, coverage: {}, mutation: {} }
      : { coverage: {}, mutation: {} };
  for (const [scope, value] of Object.entries(coverage)) {
    if (!isRecord(value)) throw new Error(`coverage scope "${scope}" must be an object`);
    const scoped = {} as CoverageThresholds;
    for (const metric of METRICS) {
      const pct = value[metric];
      if (pct === undefined) throw new Error(`coverage scope "${scope}" is missing "${metric}"`);
      if (!isPercentage(pct)) {
        throw new Error(`coverage scope "${scope}" ${metric} must be between 0 and 100`);
      }
      scoped[metric] = pct;
    }
    result.coverage[scope] = scoped;
  }
  for (const [scope, value] of Object.entries(mutation)) {
    if (!isPercentage(value)) {
      throw new Error(`mutation "${scope}" must be a number between 0 and 100`);
    }
    result.mutation[scope] = value;
  }
  return result;
}

/**
 * Aggregates an Istanbul json-summary per committed glob. Globs that match no files are
 * omitted, so packages without source are neither failed nor ratcheted to 100%.
 */
export function measureCoverage(
  summary: unknown,
  thresholds: ThresholdsFile,
  root: string,
): Measurements["coverage"] {
  if (!isRecord(summary)) throw new Error("coverage summary must be a JSON object");
  const files = Object.entries(summary)
    .filter(([file]) => file !== "total")
    .map(([file, metrics]) => ({ path: relative(root, file).replaceAll("\\", "/"), metrics }));

  const measured: Measurements["coverage"] = {};
  for (const glob of Object.keys(thresholds.coverage)) {
    const matching = files.filter((file) => matchesGlob(file.path, glob));
    if (matching.length === 0) continue;
    const scoped: Partial<CoverageThresholds> = {};
    for (const metric of METRICS) {
      let covered = 0;
      let total = 0;
      for (const file of matching) {
        const counts = isRecord(file.metrics) ? file.metrics[metric] : undefined;
        if (
          !isRecord(counts) ||
          typeof counts.covered !== "number" ||
          typeof counts.total !== "number"
        ) {
          throw new Error(`coverage summary entry for ${file.path} has no ${metric} counts`);
        }
        covered += counts.covered;
        total += counts.total;
      }
      // Nothing to count (e.g. no branches yet) proves nothing, so it never raises a threshold.
      if (total > 0) scoped[metric] = floorToTenth(covered, total);
    }
    measured[glob] = scoped;
  }
  return measured;
}

const DETECTED = new Set(["Killed", "Timeout"]);
const UNDETECTED = new Set(["Survived", "NoCoverage"]);

/**
 * Stryker's mutation score from a mutation-testing-report-schema JSON report:
 * detected / (detected + undetected), rounded down to 0.1. Errors and ignored mutants
 * do not count. Returns undefined when there are no valid mutants.
 */
export function measureMutationScore(report: unknown): number | undefined {
  if (!isRecord(report) || !isRecord(report.files)) {
    throw new Error('mutation report must have a "files" object');
  }
  let detected = 0;
  let valid = 0;
  for (const file of Object.values(report.files)) {
    if (!isRecord(file) || !Array.isArray(file.mutants)) {
      throw new Error("mutation report file entry has no mutants array");
    }
    for (const mutant of file.mutants) {
      const status = isRecord(mutant) ? mutant.status : undefined;
      if (typeof status !== "string") continue;
      if (DETECTED.has(status)) {
        detected += 1;
        valid += 1;
      } else if (UNDETECTED.has(status)) {
        valid += 1;
      }
    }
  }
  return valid === 0 ? undefined : floorToTenth(detected, valid);
}

function compare(
  committed: ThresholdsFile,
  other: Measurements,
  include: (committedValue: number, otherValue: number) => boolean,
): Change[] {
  const changes: Change[] = [];
  for (const [scope, values] of Object.entries(committed.coverage)) {
    const measured = other.coverage[scope];
    if (!measured) continue;
    for (const metric of METRICS) {
      const value = measured[metric];
      if (value !== undefined && include(values[metric], value)) {
        changes.push({ scope, metric, from: values[metric], to: value });
      }
    }
  }
  for (const [scope, value] of Object.entries(committed.mutation)) {
    const measured = other.mutation[scope];
    if (measured !== undefined && include(value, measured)) {
      changes.push({ scope, metric: "mutation", from: value, to: measured });
    }
  }
  return changes;
}

/** Raises committed thresholds to measured values. Never lowers; ignores unknown scopes. */
export function raiseThresholds(
  thresholds: ThresholdsFile,
  measured: Measurements,
): { next: ThresholdsFile; changes: Change[] } {
  const changes = findUncommittedGains(thresholds, measured);
  const next: ThresholdsFile = structuredClone(thresholds);
  for (const change of changes) {
    if (change.metric === "mutation") next.mutation[change.scope] = change.to;
    else (next.coverage[change.scope] as CoverageThresholds)[change.metric] = change.to;
  }
  return { next, changes };
}

/** Thresholds that are lower than (or missing compared with) the base. */
export function findDecreases(base: ThresholdsFile, current: ThresholdsFile): Change[] {
  const asMeasured: Measurements = {
    coverage: Object.fromEntries(
      Object.keys(base.coverage).map((scope) => [
        scope,
        current.coverage[scope] ?? { lines: 0, branches: 0, functions: 0, statements: 0 },
      ]),
    ),
    mutation: Object.fromEntries(
      Object.keys(base.mutation).map((scope) => [scope, current.mutation[scope] ?? 0]),
    ),
  };
  return compare(base, asMeasured, (baseValue, currentValue) => currentValue < baseValue);
}

/** Measured values below the committed thresholds. */
export function findRegressions(thresholds: ThresholdsFile, measured: Measurements): Change[] {
  return compare(thresholds, measured, (committed, value) => value < committed);
}

/** Measured values above committed thresholds by at least the 0.1 rounding step. */
export function findUncommittedGains(thresholds: ThresholdsFile, measured: Measurements): Change[] {
  return compare(thresholds, measured, (committed, value) => value > committed);
}

const formatChanges = (changes: Change[]) =>
  changes.map((c) => `  ${c.scope} ${c.metric}: ${c.from} → ${c.to}`).join("\n");

const USAGE = `Usage:
  node scripts/coverage-ratchet.ts update [--thresholds <file>] [--coverage <file>] [--mutation <file>] [--mutation-scope <name>]
  node scripts/coverage-ratchet.ts check [--base <file>] [--no-measure] [same options as update]`;

/** Runs the CLI. Returns the exit code: 0 ok, 1 ratchet violation, 2 usage or input error. */
export function run(argv: readonly string[], io: ScriptIo = nodeIo): number {
  const [command, ...rest] = argv;
  if (command !== "update" && command !== "check") {
    io.error(USAGE);
    return 2;
  }
  try {
    const { values } = parseArgs({
      args: [...rest],
      strict: true,
      options: {
        thresholds: { type: "string", default: DEFAULT_THRESHOLDS_PATH },
        coverage: { type: "string" },
        mutation: { type: "string" },
        "mutation-scope": { type: "string", default: DEFAULT_MUTATION_SCOPE },
        base: { type: "string" },
        "no-measure": { type: "boolean", default: false },
      },
    });
    const path = (file: string) => resolve(io.cwd, file);
    const readJson = (file: string): unknown => {
      try {
        return JSON.parse(io.readText(path(file)));
      } catch (error) {
        throw new Error(`cannot read ${file}: ${(error as Error).message}`);
      }
    };
    const parseThresholds = (file: string) => {
      try {
        return parseThresholdsFile(readJson(file));
      } catch (error) {
        throw new Error(`${file}: ${(error as Error).message}`);
      }
    };

    const thresholds = parseThresholds(values.thresholds);
    const measured: Measurements = { coverage: {}, mutation: {} };
    if (!values["no-measure"]) {
      const coveragePath = values.coverage ?? (values.mutation ? undefined : DEFAULT_SUMMARY_PATH);
      if (coveragePath) {
        measured.coverage = measureCoverage(readJson(coveragePath), thresholds, io.cwd);
      }
      if (values.mutation) {
        const score = measureMutationScore(readJson(values.mutation));
        if (score !== undefined) measured.mutation[values["mutation-scope"]] = score;
      }
    }

    if (command === "update") {
      const { next, changes } = raiseThresholds(thresholds, measured);
      if (changes.length === 0) {
        io.log("Thresholds already up to date.");
        return 0;
      }
      io.writeText(path(values.thresholds), `${JSON.stringify(next, null, 2)}\n`);
      io.log(`Raised thresholds in ${values.thresholds}:\n${formatChanges(changes)}`);
      return 0;
    }

    let failed = false;
    if (values.base) {
      const decreases = findDecreases(parseThresholds(values.base), thresholds);
      const reason = io.env[DECREASE_REASON_ENV]?.trim();
      if (decreases.length > 0 && reason) {
        io.log(
          `Threshold decrease accepted (${DECREASE_REASON_ENV}): ${reason}\n${formatChanges(decreases)}`,
        );
      } else if (decreases.length > 0) {
        failed = true;
        io.error(
          `Thresholds were lowered compared with ${values.base}:\n${formatChanges(decreases)}\n` +
            `Coverage may only go down with an approved coverage-decrease justification; ` +
            `set ${DECREASE_REASON_ENV} to the reason.`,
        );
      }
    }
    const regressions = findRegressions(thresholds, measured);
    if (regressions.length > 0) {
      failed = true;
      io.error(
        `Measured coverage is below the committed threshold:\n${formatChanges(regressions)}`,
      );
    }
    const gains = findUncommittedGains(thresholds, measured);
    if (gains.length > 0) {
      failed = true;
      io.error(
        `Coverage improved but the raised thresholds were not committed:\n${formatChanges(gains)}\n` +
          "Run `pnpm test:coverage` (or `pnpm coverage:update` after a coverage run) and commit " +
          `${values.thresholds}.`,
      );
    }
    if (failed) return 1;
    io.log("Coverage ratchet OK.");
    return 0;
  } catch (error) {
    io.error(`${(error as Error).message}\n\n${USAGE}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
