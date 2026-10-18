import { describe, expect, it } from "vitest";
import {
  correlationIdFrom,
  isValidCorrelationId,
  REQUEST_ID_HEADER,
  withCorrelationId,
} from "../src/index.ts";

function sequentialIds(prefix = "gen") {
  let n = 0;
  return {
    next: () => {
      n += 1;
      return `${prefix}-${String(n).padStart(8, "0")}`;
    },
  };
}

function requestWith(header?: string): Request {
  const headers = new Headers();
  if (header !== undefined) headers.set(REQUEST_ID_HEADER, header);
  return new Request("https://sharerepo.org/healthz", { headers });
}

describe("correlationIdFrom", () => {
  it("uses the header name x-request-id", () => {
    expect(REQUEST_ID_HEADER).toBe("x-request-id");
  });

  it.each([
    "abcdefgh",
    "0b5f7c1e-3d4a-4c8e-9a1b-2f6d8e0c4b7a",
    "trace.id:span-01_ABC",
    "a".repeat(128),
  ])("accepts a valid incoming id %s", (id) => {
    const ids = sequentialIds();
    expect(correlationIdFrom(requestWith(id), ids)).toBe(id);
  });

  it.each([
    ["too short", "abc1234"],
    ["too long", "a".repeat(129)],
    ["spaces", "abc def ghi"],
    ["injection characters", 'abcdefgh"},{"level":"error'],
    ["slashes", "../../etc/passwd"],
    ["non-ascii", "abcdefghé"],
    ["empty", ""],
  ])("generates a new id when the incoming one is %s", (_label, id) => {
    expect(correlationIdFrom(requestWith(id), sequentialIds())).toBe("gen-00000001");
  });

  it("generates a new id when the header is absent", () => {
    expect(correlationIdFrom(requestWith(), sequentialIds())).toBe("gen-00000001");
  });

  it("is compatible with a crypto.randomUUID generator", () => {
    const id = correlationIdFrom(requestWith(), { next: () => crypto.randomUUID() });
    expect(isValidCorrelationId(id)).toBe(true);
  });
});

describe("withCorrelationId", () => {
  it("sets the header on a mutable response", async () => {
    const original = new Response("ok", { status: 201, headers: { "x-other": "1" } });
    const response = withCorrelationId(original, "req-abcdefgh");
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req-abcdefgh");
    expect(response.headers.get("x-other")).toBe("1");
    expect(response.status).toBe(201);
    expect(await response.text()).toBe("ok");
  });

  it("clones a response whose headers are immutable", async () => {
    const original = Response.redirect("https://sharerepo.org/login", 302);
    expect(() => original.headers.set("x-probe", "1")).toThrow(TypeError);

    const response = withCorrelationId(original, "req-abcdefgh");
    expect(response).not.toBe(original);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("https://sharerepo.org/login");
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req-abcdefgh");
  });

  it("preserves the body and status text when cloning", async () => {
    const original = new Response("payload", { status: 418, statusText: "Teapot" });
    Object.defineProperty(original, "headers", { value: Object.freeze(immutableHeaders()) });

    const response = withCorrelationId(original, "req-abcdefgh");
    expect(response.statusText).toBe("Teapot");
    expect(await response.text()).toBe("payload");
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req-abcdefgh");
  });
});

function immutableHeaders(): Headers {
  const headers = new Headers({ "content-type": "text/plain" });
  headers.set = () => {
    throw new TypeError("immutable");
  };
  return headers;
}
