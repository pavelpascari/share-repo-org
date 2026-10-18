import { describe, expect, it } from "vitest";
import { cloudflareContext } from "../app/context.ts";
import { requestContext } from "./support/request-context.ts";

describe("cloudflare router context", () => {
  it("carries the validated env, correlation ID and logger through the router context", () => {
    const context = requestContext({ correlationId: "corr-1" });
    const value = context.get(cloudflareContext);
    expect(value.env.ENVIRONMENT).toBe("development");
    expect(value.env.auth.baseURL).toBe("http://localhost:5173");
    expect(value.correlationId).toBe("corr-1");
    expect(typeof value.logger.info).toBe("function");
  });
});
