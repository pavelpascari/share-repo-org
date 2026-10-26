import { describe, expect, it } from "vitest";
import { ConfigurationError, parseOperatorGitHubIds } from "../src/index.ts";

describe("parseOperatorGitHubIds", () => {
  it.each([
    ["unset", {}],
    ["empty", { OPERATOR_GITHUB_IDS: "" }],
    ["blank", { OPERATOR_GITHUB_IDS: "  " }],
  ])("means no operators when %s", (_, env) => {
    expect(parseOperatorGitHubIds(env).size).toBe(0);
  });

  it("parses comma-separated IDs, ignoring spaces and duplicates", () => {
    expect([...parseOperatorGitHubIds({ OPERATOR_GITHUB_IDS: " 583231, 9919 ,583231" })]).toEqual([
      "583231",
      "9919",
    ]);
  });

  it("accepts a single ID", () => {
    expect([...parseOperatorGitHubIds({ OPERATOR_GITHUB_IDS: "1" })]).toEqual(["1"]);
  });

  it.each([
    ["a login", "octocat"],
    ["a login among IDs", "583231,octocat"],
    ["an empty entry", "583231,,9919"],
    ["a trailing comma", "583231,"],
    ["a leading zero", "0583231"],
    ["zero", "0"],
    ["a negative ID", "-1"],
    ["a decimal", "1.5"],
    ["a suffix", "583231x"],
    ["a prefix", "x583231"],
    ["too many digits", "1".repeat(21)],
  ])("rejects %s without echoing it", (_, value) => {
    const parse = () => parseOperatorGitHubIds({ OPERATOR_GITHUB_IDS: value });
    expect(parse).toThrow(ConfigurationError);
    try {
      parse();
    } catch (error) {
      expect((error as ConfigurationError).issues).toEqual([
        { path: "OPERATOR_GITHUB_IDS", code: "invalid_format" },
      ]);
      expect((error as Error).message).not.toContain(value);
    }
  });

  it("accepts the longest ID", () => {
    expect(parseOperatorGitHubIds({ OPERATOR_GITHUB_IDS: "9".repeat(20) }).size).toBe(1);
  });

  it("rejects a value that is not a string", () => {
    expect(() => parseOperatorGitHubIds({ OPERATOR_GITHUB_IDS: 583231 })).toThrow(
      ConfigurationError,
    );
  });
});
