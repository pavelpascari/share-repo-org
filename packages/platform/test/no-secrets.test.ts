import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import {
  ConfigurationError,
  createLogger,
  ForbiddenError,
  parseEnv,
  toErrorResponse,
} from "../src/index.ts";
import { type ConsoleCapture, captureConsole } from "./support/capture-console.ts";

const canary = (name: string) => `canary-${name}-${crypto.randomUUID()}`;

const canaries = {
  accessToken: canary("access-token"),
  webhookSecret: canary("webhook-secret"),
  privateKey: canary("private-key"),
  cookie: canary("cookie"),
  bearer: canary("bearer"),
  password: canary("password"),
  signature: canary("signature"),
  queryToken: canary("query-token"),
  errorMessage: canary("error-message"),
  errorProperty: canary("error-property"),
  causeMessage: canary("cause-message"),
  envValue: canary("env-value"),
  githubToken: `ghs_${crypto.randomUUID().replaceAll("-", "")}`,
};

function expectNoCanary(text: string): void {
  for (const [name, value] of Object.entries(canaries)) {
    expect(text, `canary ${name} leaked`).not.toContain(value);
  }
}

let capture: ConsoleCapture;
beforeEach(() => {
  capture = captureConsole();
});
afterEach(() => {
  capture.restore();
});

describe("audit/no-secrets-in-logs-or-audit (logging)", () => {
  it("audit/no-secrets-in-logs-or-audit: canaries never reach captured console output", async () => {
    const logger = createLogger(
      { correlationId: "req-00000001", workspaceId: "ws_1", session: canaries.cookie },
      { includeStacks: true },
    ).child({ installation: { id: 42, credentials: { token: canaries.accessToken } } });

    logger.info("github webhook received", {
      headers: {
        "X-Hub-Signature-256": `sha256=${canaries.signature}`,
        Cookie: `sid=${canaries.cookie}`,
        Authorization: `Bearer ${canaries.bearer}`,
      },
      connection: {
        secrets: [{ webhookSecret: canaries.webhookSecret }],
        app: { private_key: canaries.privateKey },
      },
      users: [{ login: "octocat", password: canaries.password }],
      callbackUrl: `https://sharerepo.org/cb?state=s&access_token=${canaries.queryToken}`,
      providerResponse: `Authorization: Bearer ${canaries.bearer}`,
    });

    const providerError = new Error(`GitHub rejected token=${canaries.errorMessage}`, {
      cause: new Error(`upstream said secret=${canaries.causeMessage}`),
    });
    Object.assign(providerError, { token: canaries.errorProperty });
    logger.error(`provider call failed: Bearer ${canaries.bearer}`, { error: providerError });
    logger.warn("installation token minted", { result: `minted ${canaries.githubToken}` });

    const leakySchema = z.object({ GITHUB_WEBHOOK_SECRET: z.string().min(1000) });
    try {
      parseEnv(leakySchema, { GITHUB_WEBHOOK_SECRET: canaries.envValue });
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigurationError);
      logger.error("startup failed", { error });
      const response = toErrorResponse(error, "req-00000001");
      expectNoCanary(await response.text());
    }

    const forbidden = new ForbiddenError(`denied for token=${canaries.accessToken}`);
    logger.warn("access denied", { error: forbidden });
    expectNoCanary(await toErrorResponse(forbidden, "req-00000001").text());

    expect(capture.lines.length).toBe(5);
    expectNoCanary(capture.text());
    // Sanity check: the records themselves are still useful.
    expect(capture.text()).toContain("octocat");
    expect(capture.text()).toContain("GITHUB_WEBHOOK_SECRET (too_small)");
  });
});

describe("audit/no-secrets-in-logs-or-audit (Paddle and claims)", () => {
  it("canaries for every Phase 5 secret never reach captured console output", () => {
    const phase5 = {
      credentialKeys: canary("credential-keys"),
      claimSigningKey: canary("claim-signing-key"),
      apiKey: `pdl_sdbx_apikey_${crypto.randomUUID().replaceAll("-", "")}`,
      apiKeyEnvelope: canary("api-key-envelope"),
      webhookSecretEnvelope: canary("webhook-secret-envelope"),
      emailEnvelope: canary("email-envelope"),
      claimReference: canary("claim-reference"),
      email: canary("email"),
    };
    const logger = createLogger({ correlationId: "req-00000001" });
    logger.info("paddle connection checked", {
      env: { CREDENTIAL_KEYS: phase5.credentialKeys, CLAIM_SIGNING_KEY: phase5.claimSigningKey },
      connection: {
        apiKeyEnvelope: phase5.apiKeyEnvelope,
        webhook_secret_envelope: phase5.webhookSecretEnvelope,
      },
      request: { emailEnvelope: phase5.emailEnvelope, email: phase5.email },
      customData: { sharerepo_claim_reference: phase5.claimReference },
    });
    logger.error(`paddle rejected key ${phase5.apiKey}`);

    expect(capture.lines.length).toBe(2);
    for (const [name, value] of Object.entries(phase5)) {
      expect(capture.text(), `canary ${name} leaked`).not.toContain(value);
    }
    expect(capture.text()).toContain("paddle connection checked");
  });
});
