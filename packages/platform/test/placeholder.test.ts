import { describe, expect, it } from "vitest";
import * as platform from "../src/index.ts";

describe("platform", () => {
  it("loads", () => {
    expect(platform).toBeDefined();
  });
});
