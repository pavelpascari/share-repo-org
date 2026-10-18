import { createUserForSignIn } from "@sharerepo/application";
import { createDb, listAuditEventsByCorrelationId } from "@sharerepo/db";
import { randomIds, systemClock } from "@sharerepo/domain";
import { createLogger } from "@sharerepo/platform";
import { describe, expect, it } from "vitest";
import { createSignInRecorder, forwardAuthLog, syntheticEmail } from "../app/auth/auth.ts";
import { authFor } from "../app/auth/server.ts";
import { fakeAccount } from "./support/fake-github.ts";
import { requestContext } from "./support/request-context.ts";
import { db } from "./support/sign-in.ts";

function recordingLogger() {
  const lines: string[] = [];
  const record = (line: string) => {
    lines.push(line);
  };
  const logger = createLogger(
    { correlationId: "corr-test" },
    { sink: { debug: record, info: record, warn: record, error: record } },
  );
  return { logger, lines };
}

const services = (database = db) => ({
  db: database,
  clock: systemClock,
  ids: randomIds,
  correlationId: `corr-${crypto.randomUUID()}`,
});

describe("createSignInRecorder", () => {
  it("maps the GitHub profile to Better Auth's user fields", () => {
    const account = fakeAccount({ name: null, avatarUrl: null });
    const recorder = createSignInRecorder(services(), recordingLogger().logger);
    expect(recorder.captureProfile(account)).toEqual({
      id: account.id,
      name: account.login,
      email: syntheticEmail(account.id),
      emailVerified: true,
    });
  });

  it("refuses a session when no GitHub profile was captured in this request", async () => {
    const recorder = createSignInRecorder(services(), recordingLogger().logger);
    await expect(recorder.beforeSessionCreate({ userId: "anyone" })).resolves.toBe(false);
  });

  it("records the sign-in for the captured profile", async () => {
    const { userId } = await createUserForSignIn(services());
    const recorder = createSignInRecorder(services(), recordingLogger().logger);
    recorder.captureProfile(fakeAccount());
    await expect(recorder.beforeSessionCreate({ userId })).resolves.toBeUndefined();
  });

  it("refuses and audits a sign-in whose identity belongs to another user", async () => {
    const account = fakeAccount();
    const owner = await createUserForSignIn(services());
    const first = createSignInRecorder(services(), recordingLogger().logger);
    first.captureProfile(account);
    await first.beforeSessionCreate(owner);

    const intruder = await createUserForSignIn(services());
    const ctx = services();
    const { logger, lines } = recordingLogger();
    const second = createSignInRecorder(ctx, logger);
    second.captureProfile(account);
    await expect(second.beforeSessionCreate(intruder)).resolves.toBe(false);
    expect(await listAuditEventsByCorrelationId(db, ctx.correlationId)).toMatchObject([
      {
        action: "auth.sign_in_refused",
        target: { id: intruder.userId },
        details: { provider: "github", reason: "identity_conflict" },
      },
    ]);
    expect(lines.join("\n")).toContain('"reason":"identity_conflict"');
  });

  it.each([
    ["an error", new Error("D1 unavailable: SELECT secret params")],
    ["a non-error value", "D1 unavailable: SELECT secret params"],
  ])("refuses unexpected failures (%s) too, logging only a classification", async (_, thrown) => {
    const broken = createDb({
      prepare() {
        throw thrown;
      },
      batch() {
        throw thrown;
      },
    } as unknown as D1Database);
    const { logger, lines } = recordingLogger();
    const recorder = createSignInRecorder(services(broken), logger);
    recorder.captureProfile(fakeAccount());
    await expect(recorder.beforeSessionCreate({ userId: "anyone" })).resolves.toBe(false);
    const logged = lines.join("\n");
    expect(logged).toContain('"reason":"internal_error"');
    expect(logged).toContain("could not audit refused sign-in");
    expect(logged).not.toContain("SELECT secret params");
  });
});

describe("forwardAuthLog", () => {
  it("logs errors as errors and everything else as warnings, keeping only the message", () => {
    const { logger, lines } = recordingLogger();
    const forward = forwardAuthLog(logger);
    forward("error", "boom");
    forward("info", "fyi");
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.map(({ level, msg, authMessage }) => ({ level, msg, authMessage }))).toEqual([
      { level: "error", msg: "auth library error", authMessage: "boom" },
      { level: "warn", msg: "auth library warning", authMessage: "fyi" },
    ]);
  });
});

describe("authFor", () => {
  it("builds one Better Auth instance per request", () => {
    const context = requestContext();
    expect(authFor(context)).toBe(authFor(context));
    expect(authFor(requestContext())).not.toBe(authFor(context));
  });
});
