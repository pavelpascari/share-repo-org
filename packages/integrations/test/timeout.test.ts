import { FakeClock } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  createGitHubApp,
  createPaddleClient,
  GitHubApiError,
  PaddleApiError,
} from "../src/index.ts";
import { appKey } from "./support/keys.ts";
import { NOW, PADDLE_API, PADDLE_KEY } from "./support/paddle.ts";
import { API, hangingFetch } from "./support/stub-fetch.ts";

// provider/timeout-is-retryable at the adapter: a provider that stops answering, before its
// headers or in the middle of its body, is cut off by the client's own timeout and classified
// `transient`, which every caller retries. Never `malformed`, which callers do not retry.

const TIMEOUT_MS = 50;

describe("provider/timeout-is-retryable: the real clients enforce their timeout", () => {
  it.each(["headers", "body"] as const)(
    "GitHub: a request that hangs at its %s is aborted and transient",
    async (stage) => {
      const hanging = hangingFetch(stage);
      const app = createGitHubApp({
        appId: "1000",
        privateKeyPem: (await appKey()).pem,
        apiBaseUrl: API,
        fetch: hanging.fetch,
        clock: new FakeClock(NOW),
        requestTimeoutMs: TIMEOUT_MS,
      });
      const started = Date.now();
      const error = await app.getInstallation("42").catch((e: unknown) => e);
      expect(error).toBeInstanceOf(GitHubApiError);
      expect(error).toMatchObject({ kind: "transient" });
      expect(hanging.signals).toHaveLength(1);
      expect(hanging.signals[0]?.aborted).toBe(true);
      expect(Date.now() - started).toBeLessThan(5_000);
    },
  );

  it.each(["headers", "body"] as const)(
    "Paddle: a request that hangs at its %s is aborted and transient, without the key",
    async (stage) => {
      const hanging = hangingFetch(stage);
      const port = createPaddleClient({
        apiKey: PADDLE_KEY,
        apiBaseUrl: PADDLE_API,
        fetch: hanging.fetch,
        clock: new FakeClock(NOW),
        requestTimeoutMs: TIMEOUT_MS,
      });
      const error = await port.getApiRoot().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PaddleApiError);
      expect(error).toMatchObject({ kind: "transient" });
      expect(String((error as Error).message)).not.toContain(PADDLE_KEY);
      expect(hanging.signals[0]?.aborted).toBe(true);
    },
  );
});
