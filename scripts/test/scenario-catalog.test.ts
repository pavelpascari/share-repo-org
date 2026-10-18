// Scenario names in this file are deliberately fictional (`example/...`) so these unit tests
// never satisfy the real catalog in docs/testing-strategy.md.
import { describe, expect, it } from "vitest";
import {
  extractTestTitles,
  findMissingScenarios,
  findTestFiles,
  parsePhase,
  parseScenarioCatalog,
  run,
} from "../scenario-catalog.ts";
import { memoryIo } from "./memory-io.ts";

const DOC = `# Strategy

## Scenario catalog

Intro text.

| Scenario | Source | Layer | Phase |
|---|---|---|---|
| \`example/zero-to-three\` | Matrix | DB | 0–3 |
| \`example/two-and-five\` | Same | Service | 2, 5 |
| \`example/one-onward\` | AGENTS | Service | 1 onward |
| \`example/zero-onward\` | AGENTS | Service | 0 onward |
| \`example/four\` | Plan | Entry point | 4 |

A CI check fails if any scenario is missing.

## Next section

| Scenario | Phase |
|---|---|
| \`example/not-in-catalog\` | 0 |
`;

describe("parsePhase", () => {
  it("takes the earliest phase from ranges, lists, and open-ended phases", () => {
    expect(parsePhase("0–3")).toBe(0);
    expect(parsePhase("3-4")).toBe(3);
    expect(parsePhase("2, 5")).toBe(2);
    expect(parsePhase("6, 3")).toBe(3);
    expect(parsePhase("1 onward")).toBe(1);
    expect(parsePhase("4")).toBe(4);
  });

  it("rejects a phase cell without a number", () => {
    expect(() => parsePhase("later")).toThrow(/phase "later"/);
  });
});

describe("parseScenarioCatalog", () => {
  it("reads only the Scenario catalog table", () => {
    expect(parseScenarioCatalog(DOC)).toEqual([
      { name: "example/zero-to-three", phase: 0, phaseText: "0–3" },
      { name: "example/two-and-five", phase: 2, phaseText: "2, 5" },
      { name: "example/one-onward", phase: 1, phaseText: "1 onward" },
      { name: "example/zero-onward", phase: 0, phaseText: "0 onward" },
      { name: "example/four", phase: 4, phaseText: "4" },
    ]);
  });

  it("fails when the section or table is missing", () => {
    expect(() => parseScenarioCatalog("# Nothing here")).toThrow(/"## Scenario catalog"/);
    expect(() => parseScenarioCatalog("## Scenario catalog\n\nNo table.\n")).toThrow(/table/);
    expect(() =>
      parseScenarioCatalog("## Scenario catalog\n\n| Name | When |\n|---|---|\n| a | 1 |\n"),
    ).toThrow(/"Scenario" and "Phase" columns/);
  });

  it("fails on a row with a missing cell or name", () => {
    expect(() =>
      parseScenarioCatalog("## Scenario catalog\n\n| Scenario | Phase |\n|---|---|\n| `a` |\n"),
    ).toThrow(/row 1/);
    expect(() =>
      parseScenarioCatalog("## Scenario catalog\n\n| Scenario | Phase |\n|---|---|\n| `` | 1 |\n"),
    ).toThrow(/row 1/);
  });
});

describe("extractTestTitles", () => {
  it("finds titles of it, test, describe, and modifiers in any quote style", () => {
    const source = [
      `it("example/a double", () => {});`,
      `test('example/b single', () => {});`,
      "describe(`example/c template`, () => {});",
      `it.skip("example/d skipped", () => {});`,
      `test.describe.serial("example/e playwright", () => {});`,
      `it(\n  "example/f multiline",\n  () => {},\n);`,
      `it("escaped \\"quote\\" title", () => {});`,
      `notATest("example/g", () => {});`,
      `const s = "example/h just a string";`,
    ].join("\n");
    expect(extractTestTitles(source)).toEqual([
      "example/a double",
      "example/b single",
      "example/c template",
      "example/d skipped",
      "example/e playwright",
      "example/f multiline",
      'escaped \\"quote\\" title',
    ]);
  });
});

describe("findMissingScenarios", () => {
  const scenarios = parseScenarioCatalog(DOC);

  it("reports scenarios due at or before the phase that no test title names", () => {
    const titles = ["example/zero-to-three rejects cross-tenant links"];
    expect(findMissingScenarios(scenarios, titles, 1).map((s) => s.name)).toEqual([
      "example/one-onward",
      "example/zero-onward",
    ]);
  });

  it("requires the exact name, not a longer name that contains it", () => {
    const titles = ["example/four-and-more", "prefix-example/four"];
    expect(findMissingScenarios(scenarios, titles, 4).map((s) => s.name)).toContain("example/four");
    expect(
      findMissingScenarios(scenarios, ["[example/four] works"], 4).map((s) => s.name),
    ).not.toContain("example/four");
  });

  it("reports nothing when every due scenario has a test", () => {
    const titles = scenarios.map((s) => s.name);
    expect(findMissingScenarios(scenarios, titles, 6)).toEqual([]);
  });
});

describe("findTestFiles", () => {
  it("finds test and spec files and skips dependency and build folders", () => {
    const io = memoryIo("/repo", {
      "/repo/packages/a/test/a.test.ts": "",
      "/repo/apps/web/e2e/home.spec.ts": "",
      "/repo/apps/web/test/ui.test.tsx": "",
      "/repo/packages/a/src/a.ts": "",
      "/repo/node_modules/pkg/x.test.ts": "",
      "/repo/packages/a/node_modules/pkg/y.test.ts": "",
      "/repo/.git/z.test.ts": "",
      "/repo/coverage/c.test.ts": "",
    });
    expect(findTestFiles("/repo", io).sort()).toEqual([
      "/repo/apps/web/e2e/home.spec.ts",
      "/repo/apps/web/test/ui.test.tsx",
      "/repo/packages/a/test/a.test.ts",
    ]);
  });
});

describe("run", () => {
  const files = (tests: Record<string, string>) => ({
    "/repo/docs/testing-strategy.md": DOC,
    ...tests,
  });

  it("passes when every scenario due by the phase has a test", () => {
    const io = memoryIo(
      "/repo",
      files({
        "/repo/packages/a/test/a.test.ts": `it("example/zero-to-three", () => {});\ndescribe("example/zero-onward", () => {});`,
      }),
    );
    expect(run(["--phase", "0"], io)).toBe(0);
    expect(io.logs.join("\n")).toMatch(/2 of 2 scenarios due by phase 0 have tests/);
  });

  it("fails listing every missing scenario with its phase", () => {
    const io = memoryIo("/repo", files({}));
    expect(run(["--phase", "1"], io)).toBe(1);
    const output = io.errors.join("\n");
    expect(output).toMatch(/3 scenario\(s\) due by phase 1 have no test/);
    expect(output).toContain("example/zero-to-three (phase 0–3)");
    expect(output).toContain("example/one-onward (phase 1 onward)");
    expect(output).toContain("example/zero-onward (phase 0 onward)");
  });

  it("accepts a custom document and root", () => {
    const io = memoryIo("/elsewhere", {
      "/repo/strategy.md": DOC,
      "/repo/x.test.ts": `it("example/zero-to-three", () => {}); it("example/zero-onward", () => {});`,
    });
    expect(run(["--phase", "0", "--doc", "/repo/strategy.md", "--root", "/repo"], io)).toBe(0);
  });

  it("exits 2 on bad arguments or an unreadable document", () => {
    expect(run([], memoryIo("/repo", files({})))).toBe(2);
    expect(run(["--phase", "x"], memoryIo("/repo", files({})))).toBe(2);
    expect(run(["--phase", "-1"], memoryIo("/repo", files({})))).toBe(2);
    expect(run(["--phase", "0", "--bogus"], memoryIo("/repo", files({})))).toBe(2);
    const io = memoryIo("/repo", {});
    expect(run(["--phase", "0"], io)).toBe(2);
    expect(io.errors.join("\n")).toMatch(/testing-strategy\.md/);
  });
});
