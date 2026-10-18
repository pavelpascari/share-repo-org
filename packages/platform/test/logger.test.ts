import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLogger, isSensitiveKey, REDACTED, redact } from "../src/index.ts";
import { type ConsoleCapture, captureConsole } from "./support/capture-console.ts";

const FIXED = Date.UTC(2026, 9, 18, 12, 30, 0, 123);
const now = () => FIXED;

let capture: ConsoleCapture;
beforeEach(() => {
  capture = captureConsole();
});
afterEach(() => {
  capture.restore();
});

function only(): Record<string, unknown> {
  const records = capture.records();
  expect(records).toHaveLength(1);
  return records[0] as Record<string, unknown>;
}

describe("createLogger", () => {
  it("writes one JSON line with the standard fields", () => {
    createLogger({ correlationId: "req-00000001" }, { now }).info("request handled", {
      status: 200,
    });
    expect(capture.lines).toHaveLength(1);
    expect(capture.lines[0]?.method).toBe("info");
    expect(capture.lines[0]?.text).toBe(
      '{"ts":"2026-10-18T12:30:00.123Z","level":"info","msg":"request handled",' +
        '"correlationId":"req-00000001","status":200}',
    );
  });

  it.each(["debug", "info", "warn", "error"] as const)("routes %s to console.%s", (level) => {
    createLogger({ correlationId: "req-00000001" }, { now })[level]("hello");
    expect(capture.lines.map((line) => line.method)).toEqual([level]);
    expect(only().level).toBe(level);
  });

  it("includes workspaceId and context fields", () => {
    createLogger({ correlationId: "c-00000001", workspaceId: "ws_1", route: "/x" }, { now }).warn(
      "slow",
    );
    expect(only()).toEqual({
      ts: "2026-10-18T12:30:00.123Z",
      level: "warn",
      msg: "slow",
      correlationId: "c-00000001",
      workspaceId: "ws_1",
      route: "/x",
    });
  });

  it("defaults the clock to Date.now", () => {
    const before = Date.now();
    createLogger({ correlationId: "c-00000001" }).info("tick");
    const ts = Date.parse(String(only().ts));
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(Date.now());
  });

  it("does not let fields overwrite reserved keys", () => {
    createLogger({ correlationId: "c-00000001" }, { now }).info("real", {
      ts: "forged",
      level: "error",
      msg: "forged",
      correlationId: "forged",
    });
    expect(only()).toMatchObject({
      ts: "2026-10-18T12:30:00.123Z",
      level: "info",
      msg: "real",
      correlationId: "c-00000001",
    });
  });

  it("child loggers inherit and extend context without mutating the parent", () => {
    const parent = createLogger({ correlationId: "c-00000001" }, { now });
    const child = parent.child({ workspaceId: "ws_2", job: "reconcile" });
    const grandchild = child.child({ attempt: 2 });
    grandchild.info("retry");
    parent.info("parent");
    const [first, second] = capture.records();
    expect(first).toMatchObject({
      correlationId: "c-00000001",
      workspaceId: "ws_2",
      job: "reconcile",
      attempt: 2,
    });
    expect(second).not.toHaveProperty("workspaceId");
    expect(second).not.toHaveProperty("job");
  });

  it("can write to an injected sink", () => {
    const lines: string[] = [];
    const sink = {
      debug: (line: string) => lines.push(line),
      info: (line: string) => lines.push(line),
      warn: (line: string) => lines.push(line),
      error: (line: string) => lines.push(line),
    };
    createLogger({ correlationId: "c-00000001" }, { now, sink }).error("to sink");
    expect(lines).toHaveLength(1);
    expect(capture.lines).toHaveLength(0);
  });
});

describe("redaction", () => {
  it.each([
    "token",
    "accessToken",
    "GITHUB_TOKEN",
    "secret",
    "client_secret",
    "webhookSecret",
    "password",
    "Authorization",
    "cookie",
    "Set-Cookie",
    "api_key",
    "apiKey",
    "X-API-Key",
    "private_key",
    "privateKey",
    "signature",
    "x-hub-signature-256",
    "Paddle-Signature",
    "credential",
    "credentials",
    "session",
    "sessionId",
  ])("treats %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each(["id", "workspaceId", "status", "author", "repository", "keyVersion"])(
    "does not treat %s as sensitive",
    (key) => {
      expect(isSensitiveKey(key)).toBe(false);
    },
  );

  it("redacts sensitive keys at any depth, including arrays", () => {
    createLogger({ correlationId: "c-00000001" }, { now }).info("nested", {
      request: {
        headers: { Authorization: "Bearer abc", accept: "application/json" },
        items: [{ apiKey: "k1", name: "a" }, [{ password: "p" }]],
      },
      token: { nested: "object values are redacted whole" },
    });
    expect(only()).toMatchObject({
      request: {
        headers: { Authorization: REDACTED, accept: "application/json" },
        items: [{ apiKey: REDACTED, name: "a" }, [{ password: REDACTED }]],
      },
      token: REDACTED,
    });
  });

  it("redacts sensitive keys in context and child context", () => {
    createLogger({ correlationId: "c-00000001", session: "s" }, { now })
      .child({ credential: "c" })
      .info("ctx");
    expect(only()).toMatchObject({ session: REDACTED, credential: REDACTED });
  });

  it("scrubs secrets embedded in strings", () => {
    const out = redact({
      header: "Authorization: Bearer abc.def-ghi",
      url: "https://api.example.com/cb?code=ok&access_token=abc123&state=s",
      json: '{"client_secret":"zzz","ok":true}',
      gh: "token ghp_0123456789abcdefghijABCDEFGHIJ0123 rejected",
      pat: "github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz",
      paddle: "using pdl_live_apikey_01abcdef0123456789",
      pem: "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----",
      plain: "nothing to see",
    });
    expect(out).toEqual({
      header: "Authorization: [REDACTED]",
      url: "https://api.example.com/cb?code=ok&access_token=[REDACTED]&state=s",
      json: '{"client_secret":"[REDACTED]","ok":true}',
      gh: "token [REDACTED] rejected",
      pat: "[REDACTED]",
      paddle: "using [REDACTED]",
      pem: "[REDACTED]",
      plain: "nothing to see",
    });
  });

  it("scrubs the message itself", () => {
    createLogger({ correlationId: "c-00000001" }, { now }).warn("retrying with password=hunter2");
    expect(only().msg).toBe("retrying with password=[REDACTED]");
  });
});

describe("value serialisation", () => {
  it("serialises errors as name and message without a stack by default", () => {
    const error = new TypeError("bad token=abc123");
    Object.assign(error, { secret: "own property" });
    createLogger({ correlationId: "c-00000001" }, { now }).error("failed", { error });
    expect(only().error).toEqual({ name: "TypeError", message: "bad token=[REDACTED]" });
  });

  it("includes a redacted stack only when enabled", () => {
    const error = new Error("password=hunter2");
    createLogger({ correlationId: "c-00000001" }, { now, includeStacks: true }).error("failed", {
      error,
    });
    const logged = only().error as { stack?: string };
    expect(logged.stack).toContain("password=[REDACTED]");
    expect(logged.stack).not.toContain("hunter2");
    expect(logged.stack).toMatch(/at /);
  });

  it("serialises error causes", () => {
    const error = new Error("outer", { cause: new RangeError("inner secret=x") });
    expect(redact(error)).toEqual({
      name: "Error",
      message: "outer",
      cause: { name: "RangeError", message: "inner secret=[REDACTED]" },
    });
  });

  it("handles circular references without throwing", () => {
    const a: Record<string, unknown> = { name: "a" };
    const list: unknown[] = [a];
    a.self = a;
    a.list = list;
    list.push(list);
    const error = new Error("loop");
    (error as { cause?: unknown }).cause = error;
    expect(() =>
      createLogger({ correlationId: "c-00000001" }, { now }).info("loop", { a, error }),
    ).not.toThrow();
    expect(only()).toMatchObject({
      a: { name: "a", self: "[Circular]", list: ["[Circular]", "[Circular]"] },
      error: { name: "Error", message: "loop", cause: "[Circular]" },
    });
  });

  it("allows the same object to appear twice when it is not circular", () => {
    const shared = { v: 1 };
    expect(redact({ x: shared, y: shared })).toEqual({ x: { v: 1 }, y: { v: 1 } });
  });

  it("truncates very deep structures", () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let i = 0; i < 20; i++) deep = { deep };
    expect(JSON.stringify(redact(deep))).toContain("[Truncated]");
  });

  it("converts non-JSON values", () => {
    const out = redact({
      big: 10n,
      date: new Date(FIXED),
      invalidDate: new Date(Number.NaN),
      url: new URL("https://x.test/a?token=abc"),
      headers: new Headers({ authorization: "Bearer x", "content-type": "text/plain" }),
      map: new Map<unknown, unknown>([
        ["secret", "s"],
        ["ok", 1],
      ]),
      set: new Set(["a", "password=p"]),
      fn: () => 1,
      sym: Symbol("s"),
      undef: undefined,
      nan: Number.NaN,
    });
    expect(out).toEqual({
      big: "10",
      date: "2026-10-18T12:30:00.123Z",
      invalidDate: "Invalid Date",
      url: "https://x.test/a?token=[REDACTED]",
      headers: { authorization: REDACTED, "content-type": "text/plain" },
      map: { secret: REDACTED, ok: 1 },
      set: ["a", "password=[REDACTED]"],
      fn: "[Function]",
      sym: "Symbol(s)",
      undef: undefined,
      nan: Number.NaN,
    });
  });
});

describe("log calls never throw", () => {
  it("survives getters that throw", () => {
    const hostile = {
      get boom() {
        throw new Error("getter exploded");
      },
    };
    const logger = createLogger({ correlationId: "c-00000001" }, { now });
    expect(() => logger.info("hostile", { hostile })).not.toThrow();
    expect(only()).toEqual({
      level: "info",
      msg: "log serialisation failed",
      correlationId: "c-00000001",
    });
  });

  it("survives a clock that returns an invalid instant", () => {
    const logger = createLogger({ correlationId: "c-00000001" }, { now: () => Number.NaN });
    expect(() => logger.info("bad clock")).not.toThrow();
    expect(only().msg).toBe("log serialisation failed");
  });

  it("survives a sink that throws", () => {
    const thrower = () => {
      throw new Error("sink down");
    };
    const sink = { debug: thrower, info: thrower, warn: thrower, error: thrower };
    const logger = createLogger({ correlationId: "c-00000001" }, { now, sink });
    expect(() => logger.error("x")).not.toThrow();
  });
});
