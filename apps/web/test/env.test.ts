import { env } from "cloudflare:workers";
import { ConfigurationError } from "@sharerepo/platform";
import { describe, expect, it } from "vitest";
import { parseWebEnv } from "../workers/env.ts";

describe("parseWebEnv", () => {
  it("has no operators unless OPERATOR_GITHUB_IDS names some", () => {
    expect(parseWebEnv({ ...env, OPERATOR_GITHUB_IDS: "" }).operatorGitHubIds.size).toBe(0);
  });

  it("reads the operators' GitHub IDs (decision 0014)", () => {
    const parsed = parseWebEnv({ ...env, OPERATOR_GITHUB_IDS: "583231,9919" });
    expect([...parsed.operatorGitHubIds]).toEqual(["583231", "9919"]);
  });

  it("fails closed on an operator list that is not IDs", () => {
    expect(() => parseWebEnv({ ...env, OPERATOR_GITHUB_IDS: "octocat" })).toThrow(
      ConfigurationError,
    );
  });
});
