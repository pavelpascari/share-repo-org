import { FakeClock } from "@sharerepo/testing";
import { describe, expect, it } from "vitest";
import {
  createGitHubApp,
  createPaddleClient,
  GitHubApiError,
  type GitHubAppPort,
  PaddleApiError,
  type PaddlePort,
} from "../src/index.ts";
import { createFakeGitHubApp, createFakePaddle } from "../src/testing/index.ts";
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

// The fakes' `hangNext` stands for the same hang at the port: the contract below runs one call
// against each fake and each real client, so a fake that classified a hang differently fails.

async function realGitHub(): Promise<GitHubAppPort> {
  return createGitHubApp({
    appId: "1000",
    privateKeyPem: (await appKey()).pem,
    apiBaseUrl: API,
    fetch: hangingFetch("headers").fetch,
    clock: new FakeClock(NOW),
    requestTimeoutMs: TIMEOUT_MS,
  });
}

async function fakeGitHub(): Promise<GitHubAppPort> {
  const fake = createFakeGitHubApp();
  fake.addInstallation({
    id: "42",
    account: { id: "5001", login: "octo-creator", type: "User" },
  } as never);
  fake.hangNext("getInstallation");
  return fake;
}

describe.each([
  ["fake", fakeGitHub],
  ["real client", realGitHub],
])("provider/timeout-is-retryable: GitHubAppPort contract: %s", (_, make) => {
  it("reports a call that hangs past the timeout as transient, with no status", async () => {
    const error = await (await make()).getInstallation("42").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GitHubApiError);
    expect(error).toMatchObject({ kind: "transient", status: undefined });
  });
});

function realPaddle(): PaddlePort {
  return createPaddleClient({
    apiKey: PADDLE_KEY,
    apiBaseUrl: PADDLE_API,
    fetch: hangingFetch("body").fetch,
    clock: new FakeClock(NOW),
    requestTimeoutMs: TIMEOUT_MS,
  });
}

function fakePaddle(): PaddlePort {
  const fake = createFakePaddle();
  fake.hangNext("getApiRoot");
  return fake;
}

describe.each([
  ["fake", fakePaddle],
  ["real client", realPaddle],
])("provider/timeout-is-retryable: PaddlePort contract: %s", (_, make) => {
  it("reports a call that hangs past the timeout as transient, with no status", async () => {
    const error = await make()
      .getApiRoot()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PaddleApiError);
    expect(error).toMatchObject({ kind: "transient", status: undefined });
  });
});

describe("outage windows in the fakes", () => {
  it("fail every call with 503 until the clock reaches the end, then recover", async () => {
    const clock = new FakeClock(NOW);
    const github = createFakeGitHubApp({ clock });
    github.addInstallation({
      id: "42",
      account: { id: "5001", login: "octo-creator", type: "User" },
    } as never);
    const paddle = createFakePaddle({ clock });
    const port = paddle;
    const end = clock.now() + 60_000;
    github.outage(end);
    paddle.outage(end);
    await expect(github.getInstallation("42")).rejects.toMatchObject({
      kind: "transient",
      status: 503,
    });
    await expect(port.getApiRoot()).rejects.toMatchObject({ kind: "transient", status: 503 });
    clock.advance(59_999);
    await expect(github.getInstallation("42")).rejects.toMatchObject({ status: 503 });
    clock.advance(1);
    await expect(github.getInstallation("42")).resolves.toMatchObject({ id: "42" });
    await expect(port.getApiRoot()).resolves.toBeDefined();
  });
});
