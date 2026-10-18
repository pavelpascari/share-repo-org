// Scenario catalog check (docs/testing-strategy.md § Scenario catalog).
//
//   node scripts/scenario-catalog.ts --phase <N> [--doc <file>] [--root <dir>]
//
// Fails, listing each one, if a scenario first required at or before phase N has no test
// (it/test/describe title in a *.test.ts(x) or *.spec.ts(x) file) containing its exact name.

import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { nodeIo, type ScriptIo } from "./io.ts";

export interface Scenario {
  name: string;
  /** Earliest phase in which the scenario is required. */
  phase: number;
  phaseText: string;
}

export const DEFAULT_DOC = "docs/testing-strategy.md";
const SECTION_HEADING = "## Scenario catalog";
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".git",
  "coverage",
  "dist",
  "build",
  "reports",
  ".wrangler",
  ".react-router",
  ".stryker-tmp",
  "playwright-report",
  "test-results",
]);
const TEST_FILE = /\.(test|spec)\.tsx?$/;
// it/test/describe (with modifiers such as .skip or .describe.serial) followed by a literal title.
const TEST_TITLE =
  /(?<![\w$.])(?:it|test|describe|suite)(?:\.[A-Za-z]+)*\s*\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)'|`((?:[^`\\]|\\.)*)`)/g;
const NAME_CHAR = /[A-Za-z0-9/_-]/;

/** The earliest phase number in a cell such as "0–3", "2, 5", or "1 onward". */
export function parsePhase(text: string): number {
  const numbers = text.match(/\d+/g);
  if (!numbers) throw new Error(`cannot read phase "${text}"`);
  return Math.min(...numbers.map(Number));
}

const splitRow = (line: string) =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());

export function parseScenarioCatalog(markdown: string): Scenario[] {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === SECTION_HEADING);
  if (start === -1) throw new Error(`no "${SECTION_HEADING}" section found`);
  const end = lines.findIndex((line, index) => index > start && /^#{1,2} /.test(line));
  const section = lines.slice(start + 1, end === -1 ? undefined : end);
  const firstRow = section.findIndex((line) => line.trim().startsWith("|"));
  if (firstRow === -1) throw new Error("no table found in the scenario catalog section");

  const table: string[] = [];
  for (const line of section.slice(firstRow)) {
    if (!line.trim().startsWith("|")) break;
    table.push(line);
  }
  const header = splitRow(table[0] ?? "");
  const nameColumn = header.indexOf("Scenario");
  const phaseColumn = header.indexOf("Phase");
  if (nameColumn === -1 || phaseColumn === -1) {
    throw new Error('the scenario catalog table needs "Scenario" and "Phase" columns');
  }
  // Skip the header and the |---| separator.
  return table.slice(2).map((line, index) => {
    const cells = splitRow(line);
    const name = cells[nameColumn]?.replaceAll("`", "");
    const phaseText = cells[phaseColumn];
    if (!name || phaseText === undefined) {
      throw new Error(`scenario catalog row ${index + 1} is missing a scenario name or phase`);
    }
    return { name, phase: parsePhase(phaseText), phaseText };
  });
}

export function extractTestTitles(source: string): string[] {
  return [...source.matchAll(TEST_TITLE)].map((match) => match[1] ?? match[2] ?? match[3] ?? "");
}

/** True if `title` contains `name` not directly preceded or followed by a name character. */
function containsName(title: string, name: string): boolean {
  for (let at = title.indexOf(name); at !== -1; at = title.indexOf(name, at + 1)) {
    const before = title[at - 1];
    const after = title[at + name.length];
    const bounded = (char: string | undefined) => char === undefined || !NAME_CHAR.test(char);
    if (bounded(before) && bounded(after)) return true;
  }
  return false;
}

export function findMissingScenarios(
  scenarios: readonly Scenario[],
  titles: readonly string[],
  phase: number,
): Scenario[] {
  return scenarios.filter(
    (scenario) =>
      scenario.phase <= phase && !titles.some((title) => containsName(title, scenario.name)),
  );
}

export function findTestFiles(root: string, io: ScriptIo): string[] {
  const found: string[] = [];
  const visit = (dir: string) => {
    for (const entry of io.listDir(dir)) {
      const path = join(dir, entry.name);
      if (entry.isDirectory && !SKIPPED_DIRS.has(entry.name)) visit(path);
      else if (entry.isFile && TEST_FILE.test(entry.name)) found.push(path);
    }
  };
  visit(root);
  return found;
}

const USAGE = "Usage: node scripts/scenario-catalog.ts --phase <N> [--doc <file>] [--root <dir>]";

/** Runs the CLI. Returns the exit code: 0 ok, 1 scenarios missing, 2 usage or input error. */
export function run(argv: readonly string[], io: ScriptIo = nodeIo): number {
  try {
    const { values } = parseArgs({
      args: [...argv],
      strict: true,
      options: {
        phase: { type: "string" },
        doc: { type: "string", default: DEFAULT_DOC },
        root: { type: "string", default: "." },
      },
    });
    if (values.phase === undefined || !/^\d+$/.test(values.phase)) {
      throw new Error("--phase must be a non-negative integer");
    }
    const phase = Number(values.phase);
    const root = resolve(io.cwd, values.root);
    let markdown: string;
    try {
      markdown = io.readText(resolve(root, values.doc));
    } catch (error) {
      throw new Error(`cannot read ${values.doc}: ${(error as Error).message}`);
    }

    const scenarios = parseScenarioCatalog(markdown);
    const titles = findTestFiles(root, io).flatMap((file) => extractTestTitles(io.readText(file)));
    const due = scenarios.filter((scenario) => scenario.phase <= phase);
    const missing = findMissingScenarios(scenarios, titles, phase);
    if (missing.length > 0) {
      io.error(
        `${missing.length} scenario(s) due by phase ${phase} have no test whose title contains ` +
          `the scenario name:\n${missing.map((s) => `  - ${s.name} (phase ${s.phaseText})`).join("\n")}`,
      );
      return 1;
    }
    io.log(`${due.length} of ${due.length} scenarios due by phase ${phase} have tests.`);
    return 0;
  } catch (error) {
    io.error(`${(error as Error).message}\n${USAGE}`);
    return 2;
  }
}

if (import.meta.main) process.exitCode = run(process.argv.slice(2));
