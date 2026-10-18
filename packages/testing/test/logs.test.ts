import { afterEach, describe, expect, it } from "vitest";
import { CONSOLE_LEVELS, captureLogs, type LogCapture, safeStringify } from "../src/index.ts";

describe("captureLogs", () => {
  let capture: LogCapture | undefined;
  afterEach(() => capture?.restore());

  it("captures every console level as formatted lines", () => {
    capture = captureLogs();
    console.log("plain", 1);
    console.info({ msg: "hello", n: 2 });
    console.warn("warned");
    console.error(new Error("boom"));
    console.debug("dbg", ["a", 1n]);
    expect(capture.entries.map((e) => e.level)).toEqual(["log", "info", "warn", "error", "debug"]);
    expect(capture.lines()).toEqual([
      "plain 1",
      '{"msg":"hello","n":2}',
      "warned",
      expect.stringContaining("Error: boom"),
      'dbg ["a","1n"]',
    ]);
    expect(capture.entries[0]?.args).toEqual(["plain", 1]);
    expect(capture.text()).toContain("warned\n");
  });

  // workerd returns a freshly bound function on every read of a console method, so
  // restoration is checked through the own property descriptors instead of identity.
  const descriptors = () =>
    Object.fromEntries(
      CONSOLE_LEVELS.map((level) => [level, Object.getOwnPropertyDescriptor(console, level)]),
    );

  it("restores the original console methods", () => {
    const before = descriptors();
    capture = captureLogs();
    expect(descriptors()).not.toEqual(before);
    capture.restore();
    expect(descriptors()).toEqual(before);
    console.log("after restore");
    expect(capture.lines()).toEqual([]);
  });

  it("restores console methods that were own properties", () => {
    const own = (...args: unknown[]) => args;
    Object.defineProperty(console, "debug", { value: own, writable: true, configurable: true });
    try {
      capture = captureLogs();
      capture.restore();
      expect(Object.getOwnPropertyDescriptor(console, "debug")?.value).toBe(own);
    } finally {
      Reflect.deleteProperty(console, "debug");
    }
  });

  it("is safe to restore twice", () => {
    const before = descriptors();
    capture = captureLogs();
    capture.restore();
    capture.restore();
    expect(descriptors()).toEqual(before);
  });

  it("restores when used with `using`", () => {
    const before = descriptors();
    {
      using logs = captureLogs();
      console.info("inside");
      expect(logs.lines()).toEqual(["inside"]);
    }
    expect(descriptors()).toEqual(before);
  });

  it("can clear captured entries", () => {
    capture = captureLogs();
    console.log("one");
    capture.clear();
    console.log("two");
    expect(capture.lines()).toEqual(["two"]);
  });

  it("serialises circular objects without throwing", () => {
    capture = captureLogs();
    const value: Record<string, unknown> = { name: "loop" };
    value.self = value;
    console.log(value);
    expect(capture.lines()).toEqual(['{"name":"loop","self":"[Circular]"}']);
  });

  it("serialises nested symbols, functions, errors, and bigints", () => {
    const error = new Error("inner");
    const text = safeStringify({ s: Symbol("x"), f: () => 1, g: () => {}, e: error, n: 2n });
    expect(JSON.parse(text)).toEqual({
      s: "Symbol(x)",
      f: "[Function f]",
      g: "[Function g]",
      e: { name: "Error", message: "inner", stack: error.stack },
      n: "2n",
    });
    expect(safeStringify([() => {}][0])).toBe("[Function anonymous]");
    expect(safeStringify(JSON.parse("[1]").map(() => () => 1))).toBe('["[Function anonymous]"]');
  });

  it("falls back to name and message for an error without a stack", () => {
    const error = new TypeError("no stack");
    Reflect.deleteProperty(error, "stack");
    Object.defineProperty(error, "stack", { value: undefined });
    expect(safeStringify(error)).toBe("TypeError: no stack");
  });

  it("formats undefined, symbols, and functions", () => {
    capture = captureLogs();
    console.log(undefined, Symbol("s"), function named() {});
    expect(capture.lines()).toEqual(["undefined Symbol(s) [Function named]"]);
  });
});
