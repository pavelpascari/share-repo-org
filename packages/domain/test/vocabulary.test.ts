import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_SCOPES,
  IDENTITY_PROVIDERS,
  SIGN_IN_REFUSAL_REASONS,
} from "../src/index.ts";

// These lists feed database CHECK constraints; changing one needs a migration.
describe("persisted vocabularies", () => {
  it("audit scopes", () => expect(AUDIT_SCOPES).toEqual(["workspace", "account"]));
  it("audit actor types", () =>
    expect(AUDIT_ACTOR_TYPES).toEqual(["user", "system", "operator", "provider"]));
  it("identity providers", () => expect(IDENTITY_PROVIDERS).toEqual(["github"]));
  it("sign-in refusal reasons", () =>
    expect(SIGN_IN_REFUSAL_REASONS).toEqual(["identity_conflict", "internal_error"]));
});
