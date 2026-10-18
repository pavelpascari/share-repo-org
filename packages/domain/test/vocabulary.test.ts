import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_SCOPES,
  CONNECTABLE_ACCOUNT_TYPES,
  CONNECTION_STATUSES,
  EXTERNAL_EVENT_STATES,
  IDENTITY_PROVIDERS,
  OUTBOX_KINDS,
  RESOURCE_SELECTIONS,
  RESOURCE_TYPES,
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
  it("connection statuses", () =>
    expect(CONNECTION_STATUSES).toEqual(["active", "suspended", "deleted"]));
  it("connectable account types", () => expect(CONNECTABLE_ACCOUNT_TYPES).toEqual(["user"]));
  it("resource types", () => expect(RESOURCE_TYPES).toEqual(["repository"]));
  it("resource selections", () => expect(RESOURCE_SELECTIONS).toEqual(["selected", "removed"]));
  it("external event states", () =>
    expect(EXTERNAL_EVENT_STATES).toEqual(["pending", "processed", "ignored", "failed"]));
  it("outbox kinds", () =>
    expect(OUTBOX_KINDS).toEqual(["process_external_event", "resync_connection"]));
});
