import { ConfigurationError } from "@sharerepo/platform";
import { withSecretCanaries } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { parseAuthEnv } from "../app/auth/env.ts";
import { GITHUB_ENDPOINTS } from "../app/auth/github.ts";

const SECRET = "s".repeat(32);

const base = {
  ENVIRONMENT: "production",
  BETTER_AUTH_SECRET: SECRET,
  BETTER_AUTH_URL: "https://sharerepo.org",
  GITHUB_CLIENT_ID: "client-id",
  GITHUB_CLIENT_SECRET: "client-secret",
};

function issuesOf(env: unknown) {
  try {
    parseAuthEnv(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return (error as ConfigurationError).issues;
  }
  throw new Error("expected parseAuthEnv to throw");
}

describe("parseAuthEnv", () => {
  it("maps a production env to config with the fixed GitHub endpoints", () => {
    expect(parseAuthEnv(base)).toEqual({
      environment: "production",
      baseURL: "https://sharerepo.org",
      secret: SECRET,
      github: { clientId: "client-id", clientSecret: "client-secret", endpoints: GITHUB_ENDPOINTS },
    });
  });

  it("ignores unrelated bindings", () => {
    expect(parseAuthEnv({ ...base, DB: {}, OTHER: "x" }).environment).toBe("production");
  });

  it("requires every key", () => {
    expect(issuesOf({})).toEqual([
      { path: "ENVIRONMENT", code: "invalid_value" },
      { path: "BETTER_AUTH_SECRET", code: "invalid_type" },
      { path: "BETTER_AUTH_URL", code: "invalid_type" },
      { path: "GITHUB_CLIENT_ID", code: "invalid_type" },
      { path: "GITHUB_CLIENT_SECRET", code: "invalid_type" },
    ]);
  });

  it("rejects a non-object env", () => {
    expect(issuesOf(undefined)).toEqual([{ path: "(root)", code: "invalid_type" }]);
  });

  it("rejects an unknown environment", () => {
    expect(issuesOf({ ...base, ENVIRONMENT: "staging" })).toEqual([
      { path: "ENVIRONMENT", code: "invalid_value" },
    ]);
  });

  it("requires a secret of at least 32 characters", () => {
    expect(issuesOf({ ...base, BETTER_AUTH_SECRET: "s".repeat(31) })).toEqual([
      { path: "BETTER_AUTH_SECRET", code: "too_small" },
    ]);
  });

  it("security/blank-secret-fails-closed: rejects a whitespace-only auth or client secret", () => {
    expect(
      issuesOf({ ...base, BETTER_AUTH_SECRET: " ".repeat(40), GITHUB_CLIENT_SECRET: "\n" }),
    ).toEqual([
      { path: "BETTER_AUTH_SECRET", code: "invalid_format" },
      { path: "GITHUB_CLIENT_SECRET", code: "invalid_format" },
    ]);
  });

  it("rejects empty client credentials", () => {
    expect(issuesOf({ ...base, GITHUB_CLIENT_ID: "", GITHUB_CLIENT_SECRET: "" })).toEqual([
      { path: "GITHUB_CLIENT_ID", code: "too_small" },
      { path: "GITHUB_CLIENT_SECRET", code: "too_small" },
    ]);
  });

  it.each(["not a url", "ftp://sharerepo.org", "javascript:alert(1)"])(
    "rejects BETTER_AUTH_URL %j",
    (url) => {
      expect(issuesOf({ ...base, BETTER_AUTH_URL: url })).toEqual([
        { path: "BETTER_AUTH_URL", code: "invalid_format" },
      ]);
    },
  );

  it("requires https in production", () => {
    expect(issuesOf({ ...base, BETTER_AUTH_URL: "http://sharerepo.org" })).toEqual([
      { path: "BETTER_AUTH_URL", code: "custom" },
    ]);
  });

  it.each(["development", "e2e"])("allows http on localhost environments (%s)", (environment) => {
    const config = parseAuthEnv({
      ...base,
      ENVIRONMENT: environment,
      BETTER_AUTH_URL: "http://localhost:5173",
    });
    expect(config.baseURL).toBe("http://localhost:5173");
    expect(config.github.endpoints).toEqual(GITHUB_ENDPOINTS);
  });

  describe("GitHub endpoint overrides", () => {
    const overrides = {
      GITHUB_OAUTH_BASE_URL: "http://localhost:5190/",
      GITHUB_API_BASE_URL: "http://localhost:5190/api/",
    };

    it("are applied in e2e, with trailing slashes trimmed", () => {
      const config = parseAuthEnv({
        ...base,
        ...overrides,
        ENVIRONMENT: "e2e",
        BETTER_AUTH_URL: "http://localhost:5180",
      });
      expect(config.github.endpoints).toEqual({
        authorizeUrl: "http://localhost:5190/login/oauth/authorize",
        tokenUrl: "http://localhost:5190/login/oauth/access_token",
        apiBaseUrl: "http://localhost:5190/api",
      });
    });

    it("can override only the OAuth or only the API host in e2e", () => {
      const e2e = { ...base, ENVIRONMENT: "e2e" };
      expect(
        parseAuthEnv({ ...e2e, GITHUB_OAUTH_BASE_URL: "http://localhost:5190" }).github.endpoints,
      ).toEqual({
        authorizeUrl: "http://localhost:5190/login/oauth/authorize",
        tokenUrl: "http://localhost:5190/login/oauth/access_token",
        apiBaseUrl: GITHUB_ENDPOINTS.apiBaseUrl,
      });
      expect(
        parseAuthEnv({ ...e2e, GITHUB_API_BASE_URL: "http://localhost:5190/api" }).github.endpoints,
      ).toEqual({
        authorizeUrl: GITHUB_ENDPOINTS.authorizeUrl,
        tokenUrl: GITHUB_ENDPOINTS.tokenUrl,
        apiBaseUrl: "http://localhost:5190/api",
      });
    });

    it.each(["development", "production"])("are rejected in %s", (environment) => {
      expect(issuesOf({ ...base, ...overrides, ENVIRONMENT: environment })).toEqual([
        { path: "GITHUB_OAUTH_BASE_URL", code: "custom" },
        { path: "GITHUB_API_BASE_URL", code: "custom" },
      ]);
    });

    it("are rejected one at a time too", () => {
      expect(issuesOf({ ...base, GITHUB_API_BASE_URL: overrides.GITHUB_API_BASE_URL })).toEqual([
        { path: "GITHUB_API_BASE_URL", code: "custom" },
      ]);
    });

    it("must be http(s) URLs", () => {
      expect(
        issuesOf({ ...base, ENVIRONMENT: "e2e", GITHUB_OAUTH_BASE_URL: "file:///etc/passwd" }),
      ).toEqual([{ path: "GITHUB_OAUTH_BASE_URL", code: "invalid_format" }]);
    });
  });

  it("never echoes secret values in errors", async () => {
    await withSecretCanaries(["authSecret", "clientSecret", "url"], (canaries) => {
      let thrown: unknown;
      try {
        parseAuthEnv({
          ENVIRONMENT: "production",
          BETTER_AUTH_SECRET: canaries.authSecret,
          BETTER_AUTH_URL: `http://${canaries.url}.example`,
          GITHUB_CLIENT_ID: "",
          GITHUB_CLIENT_SECRET: canaries.clientSecret,
          GITHUB_OAUTH_BASE_URL: `https://${canaries.url}.example`,
        });
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(ConfigurationError);
      return thrown;
    });
  });
});
