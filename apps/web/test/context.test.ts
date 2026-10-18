import { env } from "cloudflare:workers";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { cloudflareContext } from "../app/context.ts";

describe("cloudflare router context", () => {
  it("carries the Worker env through the router context", () => {
    const context = new RouterContextProvider();
    context.set(cloudflareContext, { env, ctx: {} as ExecutionContext });
    expect(context.get(cloudflareContext).env.ENVIRONMENT).toBe("development");
  });
});
