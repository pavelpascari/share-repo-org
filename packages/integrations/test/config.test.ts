import { ConfigurationError } from "@sharerepo/platform";
import { createSecretCanaries, expectNoCanaryLeak } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import { normalizePrivateKey, parseGitHubAppConfig } from "../src/index.ts";

const KEY =
  "-----BEGIN PRIVATE KEY-----\nMIIBVQIBADANBgkqhkiG9w0BAQEFAASC\nAT8=\n-----END PRIVATE KEY-----";
const all = { requireWebhookSecret: true, requireSlug: true };

const env = (overrides: Record<string, unknown> = {}) => ({
  ENVIRONMENT: "production",
  GITHUB_APP_ID: "123456",
  GITHUB_APP_SLUG: "sharerepo",
  GITHUB_APP_PRIVATE_KEY: KEY,
  GITHUB_WEBHOOK_SECRET: "whsec",
  ...overrides,
});

function issuesOf(fn: () => unknown) {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigurationError);
    return (error as ConfigurationError).issues;
  }
  throw new Error("expected a ConfigurationError");
}

describe("parseGitHubAppConfig", () => {
  it("parses a production configuration with github.com defaults", () => {
    expect(parseGitHubAppConfig(env(), all)).toEqual({
      appId: "123456",
      slug: "sharerepo",
      privateKeyPem: KEY,
      webhookSecret: "whsec",
      apiBaseUrl: "https://api.github.com",
      webBaseUrl: "https://github.com",
    });
  });

  it("omits the optional slug and secret when not required and absent", () => {
    const config = parseGitHubAppConfig(
      env({ GITHUB_APP_SLUG: undefined, GITHUB_WEBHOOK_SECRET: undefined }),
      { requireWebhookSecret: false, requireSlug: false },
    );
    expect(config).not.toHaveProperty("slug");
    expect(config).not.toHaveProperty("webhookSecret");
  });

  it("accepts the previous webhook secret while it is rotated", () => {
    expect(
      parseGitHubAppConfig(env({ GITHUB_WEBHOOK_SECRET_PREVIOUS: "whsec-old" }), all),
    ).toMatchObject({ webhookSecret: "whsec", webhookSecretPrevious: "whsec-old" });
  });

  it.each([undefined, ""])("has no previous webhook secret when it is %j", (previous) => {
    const config = parseGitHubAppConfig(env({ GITHUB_WEBHOOK_SECRET_PREVIOUS: previous }), all);
    expect(config).not.toHaveProperty("webhookSecretPrevious");
  });

  it.each([undefined, ""])("disables GitHub in development when the App ID is %j", (id) => {
    expect(parseGitHubAppConfig({ ENVIRONMENT: "development", GITHUB_APP_ID: id }, all)).toBeNull();
  });

  it("requires every key in development once an App ID is set", () => {
    expect(
      issuesOf(() => parseGitHubAppConfig({ ENVIRONMENT: "development", GITHUB_APP_ID: "1" }, all)),
    ).toEqual([
      { path: "GITHUB_APP_PRIVATE_KEY", code: "invalid_type" },
      { path: "GITHUB_APP_SLUG", code: "invalid_type" },
      { path: "GITHUB_WEBHOOK_SECRET", code: "invalid_type" },
    ]);
  });

  it.each(["", "0", "12a", "-1", "01"])("rejects the App ID %j outside development", (id) => {
    expect(issuesOf(() => parseGitHubAppConfig(env({ GITHUB_APP_ID: id }), all))).toEqual([
      { path: "GITHUB_APP_ID", code: "invalid_format" },
    ]);
  });

  it("accepts the endpoint overrides only in e2e, trimming trailing slashes", () => {
    const overrides = {
      GITHUB_API_BASE_URL: "http://localhost:5190/api/",
      GITHUB_OAUTH_BASE_URL: "http://localhost:5190/",
    };
    expect(parseGitHubAppConfig(env({ ENVIRONMENT: "e2e", ...overrides }), all)).toMatchObject({
      apiBaseUrl: "http://localhost:5190/api",
      webBaseUrl: "http://localhost:5190",
    });
    for (const environment of ["production", "development"]) {
      expect(
        issuesOf(() => parseGitHubAppConfig(env({ ENVIRONMENT: environment, ...overrides }), all)),
      ).toEqual([
        { path: "GITHUB_API_BASE_URL", code: "custom" },
        { path: "GITHUB_OAUTH_BASE_URL", code: "custom" },
      ]);
    }
  });

  it("never echoes secret values in errors", () => {
    const canaries = createSecretCanaries(["key", "secret"]);
    const error = (() => {
      try {
        parseGitHubAppConfig(
          env({
            GITHUB_APP_ID: "x",
            GITHUB_APP_PRIVATE_KEY: `-----BEGIN RSA PRIVATE KEY-----\n${canaries.key}`,
            GITHUB_WEBHOOK_SECRET: canaries.secret,
          }),
          all,
        );
      } catch (caught) {
        return caught;
      }
    })();
    expect(error).toBeInstanceOf(ConfigurationError);
    expectNoCanaryLeak(error, canaries);
  });
});

describe("normalizePrivateKey", () => {
  it("turns literal \\n sequences into newlines and trims", () => {
    expect(normalizePrivateKey(`  ${KEY.replaceAll("\n", "\\n")}\\n `)).toBe(KEY);
    expect(normalizePrivateKey(KEY.replaceAll("\n", "\r\n"))).toBe(KEY);
  });

  it("refuses a PKCS#1 key, pointing to the runbook conversion, without echoing it", () => {
    const pkcs1 = "-----BEGIN RSA PRIVATE KEY-----\nSECRETBODY\n-----END RSA PRIVATE KEY-----";
    expect(issuesOf(() => normalizePrivateKey(pkcs1))).toEqual([
      { path: "GITHUB_APP_PRIVATE_KEY", code: "pkcs1_private_key" },
    ]);
    expect(() => normalizePrivateKey(pkcs1)).toThrow("docs/runbooks/github-app-setup.md");
    expect(() => normalizePrivateKey(pkcs1)).not.toThrow("SECRETBODY");
  });

  it.each([
    "not a key",
    "-----BEGIN PRIVATE KEY-----\n-----END PRIVATE KEY-----",
    "-----BEGIN PRIVATE KEY-----\nnot base64!\n-----END PRIVATE KEY-----",
  ])("refuses anything but a PKCS#8 PEM: %j", (raw) => {
    expect(issuesOf(() => normalizePrivateKey(raw))).toEqual([
      { path: "GITHUB_APP_PRIVATE_KEY", code: "invalid_private_key" },
    ]);
  });
});
