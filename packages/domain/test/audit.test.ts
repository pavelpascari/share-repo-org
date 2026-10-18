import { describe, expect, it } from "vitest";
import {
  AUDIT_ACTIONS,
  type AuditAction,
  type AuditContext,
  type AuditDetails,
  auditEvent,
  type Clock,
  type IdGenerator,
} from "../src/index.ts";

// Local doubles: the domain package has no dependency on @sharerepo/testing.
function context(correlationId = "corr-1"): AuditContext {
  let n = 0;
  const ids: IdGenerator = { next: () => `id-${++n}` };
  const clock: Clock = { now: () => 1_700_000_000_000 };
  return { ids, clock, correlationId };
}

const user = { type: "user", id: "u1" } as const;

/** One valid details object per action; every field is required, and every string non-empty. */
const VALID_DETAILS = {
  "user.created": {},
  "identity.linked": { provider: "github", externalUserId: "583231", username: "octocat" },
  "identity.snapshot_updated": {
    provider: "github",
    externalUserId: "583231",
    previousUsername: "octocat",
    username: "monalisa",
  },
  "auth.signed_in": { provider: "github" },
  "auth.signed_out": {},
  "auth.sign_in_refused": { provider: "github", reason: "identity_conflict" },
  "workspace.created": { slug: "acme", name: "Acme" },
  "workspace.renamed": { previousName: "Acme", name: "Acme Labs" },
  "membership.added": { role: "owner" },
  "connection.intent_created": { provider: "github" },
  "connection.created": { provider: "github", installationId: "4242", accountLogin: "octocat" },
  "connection.status_changed": { previousStatus: "active", status: "suspended" },
  "connection.synced": { discovered: 2, updated: 1, removed: 0 },
  "resource.discovered": { externalId: "1296269", name: "octocat/hello", private: true },
  "resource.updated": {
    externalId: "1296269",
    changes: { name: { from: "octocat/hello", to: "octocat/hello-world" } },
  },
  "resource.selection_changed": {
    externalId: "1296269",
    previousSelection: "selected",
    selection: "removed",
  },
} as const satisfies { [A in AuditAction]: AuditDetails<A> };

const ACTIONS = Object.keys(VALID_DETAILS) as AuditAction[];

describe("audit action catalog", () => {
  it("defines exactly the documented actions", () => {
    expect(Object.keys(AUDIT_ACTIONS).sort()).toEqual([...ACTIONS].sort());
  });

  it.each([
    ["user.created", "account", "user"],
    ["identity.linked", "account", "external_identity"],
    ["identity.snapshot_updated", "account", "external_identity"],
    ["auth.signed_in", "account", "user"],
    ["auth.signed_out", "account", "user"],
    ["auth.sign_in_refused", "account", "user"],
    ["workspace.created", "workspace", "workspace"],
    ["workspace.renamed", "workspace", "workspace"],
    ["membership.added", "workspace", "user"],
    ["connection.intent_created", "workspace", "connection_intent"],
    ["connection.created", "workspace", "connection"],
    ["connection.status_changed", "workspace", "connection"],
    ["connection.synced", "workspace", "connection"],
    ["resource.discovered", "workspace", "resource"],
    ["resource.updated", "workspace", "resource"],
    ["resource.selection_changed", "workspace", "resource"],
  ] as const)("%s is %s-scoped and targets a %s", (action, scope, targetType) => {
    expect(AUDIT_ACTIONS[action].scope).toBe(scope);
    expect(AUDIT_ACTIONS[action].targetType).toBe(targetType);
  });

  describe.each(ACTIONS)("%s details", (action) => {
    const schema = AUDIT_ACTIONS[action].details;
    const valid: Readonly<Record<string, unknown>> = VALID_DETAILS[action];
    const stringKeys = Object.keys(valid).filter((key) => typeof valid[key] === "string");

    it("accept the documented shape", () => {
      expect(schema.parse(valid)).toEqual(valid);
    });

    it("reject unknown keys, so nothing unvetted reaches the audit trail", () => {
      expect(schema.safeParse({ ...valid, token: "x" }).success).toBe(false);
    });

    it.each(Object.keys(valid))("require %s", (key) => {
      const { [key]: _omitted, ...rest } = valid;
      expect(schema.safeParse(rest).success).toBe(false);
    });

    it.skipIf(stringKeys.length === 0).each(stringKeys)("reject an empty %s", (key) => {
      expect(schema.safeParse({ ...valid, [key]: "" }).success).toBe(false);
    });
  });

  it.each([
    ["identity.linked", "provider", "gitlab"],
    ["identity.snapshot_updated", "provider", "gitlab"],
    ["auth.signed_in", "provider", "gitlab"],
    ["workspace.renamed", "previousName", ""],
    ["workspace.renamed", "name", ""],
    ["membership.added", "role", "admin"],
    ["auth.sign_in_refused", "reason", "because"],
    ["connection.intent_created", "provider", "gitlab"],
    ["connection.created", "provider", "gitlab"],
    ["connection.status_changed", "status", "paused"],
    ["connection.status_changed", "previousStatus", "paused"],
    ["connection.status_changed", "status", "active"],
    ["connection.synced", "discovered", -1],
    ["connection.synced", "updated", 1.5],
    ["connection.synced", "removed", "1"],
    ["resource.discovered", "private", "yes"],
    ["resource.selection_changed", "selection", "pending"],
    ["resource.selection_changed", "previousSelection", "pending"],
    ["resource.selection_changed", "selection", "selected"],
    ["resource.updated", "changes", {}],
    ["resource.updated", "changes", { token: { from: "a", to: "b" } }],
    ["resource.updated", "changes", { name: { from: "a" } }],
    ["resource.updated", "changes", { name: { from: "a", to: "" } }],
    ["resource.updated", "changes", { name: { from: "a", to: "b", extra: 1 } }],
    ["resource.updated", "changes", { private: { from: true, to: "false" } }],
    ["resource.updated", "changes", { archived: { from: 0, to: 1 } }],
    ["resource.updated", "changes", { ownerExternalId: { from: "1", to: 2 } }],
  ] as const)("%s rejects %s %j", (action, key, value) => {
    const details = { ...VALID_DETAILS[action], [key]: value };
    expect(AUDIT_ACTIONS[action].details.safeParse(details).success).toBe(false);
  });
});

describe("resource and connection details", () => {
  it.each([
    { name: { from: "a/b", to: "a/c" } },
    { private: { from: true, to: false } },
    { archived: { from: false, to: true } },
    { ownerExternalId: { from: "1", to: "2" } },
    {
      name: { from: "a/b", to: "c/b" },
      private: { from: false, to: true },
      archived: { from: true, to: false },
      ownerExternalId: { from: "1", to: "2" },
    },
  ])("resource.updated accepts changes %j", (changes) => {
    const details = { externalId: "1", changes };
    expect(AUDIT_ACTIONS["resource.updated"].details.parse(details)).toEqual(details);
  });

  it("connection.synced accepts zero counts", () => {
    const details = { discovered: 0, updated: 0, removed: 0 };
    expect(AUDIT_ACTIONS["connection.synced"].details.parse(details)).toEqual(details);
  });

  it.each([
    ["connection.status_changed", { previousStatus: "deleted", status: "active" }],
    [
      "resource.selection_changed",
      { externalId: "1", previousSelection: "removed", selection: "selected" },
    ],
  ] as const)("%s accepts any real transition %j", (action, details) => {
    expect(AUDIT_ACTIONS[action].details.parse(details)).toEqual(details);
  });
});

describe("auditEvent", () => {
  it("builds an account-scoped event", () => {
    expect(
      auditEvent(
        "identity.linked",
        { actor: user, targetId: "ei1", details: VALID_DETAILS["identity.linked"] },
        context(),
      ),
    ).toEqual({
      id: "id-1",
      scope: "account",
      workspaceId: null,
      actor: { type: "user", id: "u1" },
      action: "identity.linked",
      target: { type: "external_identity", id: "ei1" },
      reason: null,
      correlationId: "corr-1",
      occurredAt: 1_700_000_000_000,
      details: { provider: "github", externalUserId: "583231", username: "octocat" },
    });
  });

  it("builds a workspace-scoped event with a reason", () => {
    expect(
      auditEvent(
        "workspace.created",
        {
          workspaceId: "w1",
          actor: user,
          targetId: "w1",
          reason: "created from the dashboard",
          details: { slug: "acme", name: "Acme" },
        },
        context("corr-2"),
      ),
    ).toEqual({
      id: "id-1",
      scope: "workspace",
      workspaceId: "w1",
      actor: { type: "user", id: "u1" },
      action: "workspace.created",
      target: { type: "workspace", id: "w1" },
      reason: "created from the dashboard",
      correlationId: "corr-2",
      occurredAt: 1_700_000_000_000,
      details: { slug: "acme", name: "Acme" },
    });
  });

  it("allows an anonymous system actor", () => {
    const event = auditEvent(
      "user.created",
      { actor: { type: "system", id: null }, targetId: "u1", details: {} },
      context(),
    );
    expect(event.actor).toEqual({ type: "system", id: null });
  });

  it.each(["user", "operator", "provider"] as const)("requires an ID for a %s actor", (type) => {
    expect(() =>
      auditEvent(
        "user.created",
        { actor: { type, id: null }, targetId: "u1", details: {} },
        context(),
      ),
    ).toThrow("audit actor of type");
  });

  it("requires a workspace ID for a workspace-scoped action", () => {
    const input = { actor: user, targetId: "u1", details: { role: "owner" } };
    // @ts-expect-error workspaceId is required for workspace-scoped actions
    expect(() => auditEvent("membership.added", input, context())).toThrow(
      "membership.added is workspace-scoped",
    );
  });

  it("rejects an empty workspace ID", () => {
    expect(() =>
      auditEvent(
        "membership.added",
        { workspaceId: "", actor: user, targetId: "u1", details: { role: "owner" } },
        context(),
      ),
    ).toThrow("membership.added is workspace-scoped");
  });

  it("rejects a workspace ID on an account-scoped action", () => {
    const input = { workspaceId: "w1", actor: user, targetId: "u1", details: {} };
    // @ts-expect-error workspaceId is not allowed for account-scoped actions
    expect(() => auditEvent("user.created", input, context())).toThrow(
      "user.created is account-scoped",
    );
  });

  it("rejects an unknown action", () => {
    const action = "user.deleted" as AuditAction;
    expect(() =>
      auditEvent(action, { actor: user, targetId: "u1", details: {} } as never, context()),
    ).toThrow("unknown audit action: user.deleted");
  });

  it("rejects an action inherited from Object.prototype", () => {
    const action = "toString" as AuditAction;
    expect(() =>
      auditEvent(action, { actor: user, targetId: "u1", details: {} } as never, context()),
    ).toThrow("unknown audit action: toString");
  });

  it("rejects invalid details without echoing their values", () => {
    const build = () =>
      auditEvent(
        "auth.signed_in",
        // @ts-expect-error unknown keys are not part of the details type
        { actor: user, targetId: "u1", details: { provider: "github", token: "canary-secret" } },
        context(),
      );
    expect(build).toThrow("invalid details for auth.signed_in: token");
    expect(build).not.toThrow("canary-secret");
  });

  it("names every unknown key", () => {
    expect(() =>
      auditEvent(
        "user.created",
        // @ts-expect-error unknown keys are not part of the details type
        { actor: user, targetId: "u1", details: { a: "1", b: "2" } },
        context(),
      ),
    ).toThrow("invalid details for user.created: a, b");
  });

  it("names the invalid fields", () => {
    expect(() =>
      auditEvent(
        "workspace.created",
        { workspaceId: "w1", actor: user, targetId: "w1", details: { slug: "", name: "" } },
        context(),
      ),
    ).toThrow("invalid details for workspace.created: slug, name");
  });

  it("names nested fields with their path", () => {
    const build = () =>
      auditEvent(
        "resource.updated",
        {
          workspaceId: "w1",
          actor: { type: "system", id: null },
          targetId: "r1",
          details: {
            externalId: "1",
            // @ts-expect-error unknown keys are not part of the details type
            changes: { name: { from: "a", to: "" }, token: { from: "s3cret", to: "x" } },
          },
        },
        context(),
      );
    expect(build).toThrow("invalid details for resource.updated: changes.name.to, changes.token");
    expect(build).not.toThrow("s3cret");
  });

  it("names the field of a refused transition", () => {
    expect(() =>
      auditEvent(
        "connection.status_changed",
        {
          workspaceId: "w1",
          actor: { type: "system", id: null },
          targetId: "c1",
          details: { previousStatus: "active", status: "active" },
        },
        context(),
      ),
    ).toThrow("invalid details for connection.status_changed: status");
    expect(() =>
      auditEvent(
        "resource.selection_changed",
        {
          workspaceId: "w1",
          actor: { type: "system", id: null },
          targetId: "r1",
          details: { externalId: "1", previousSelection: "removed", selection: "removed" },
        },
        context(),
      ),
    ).toThrow("invalid details for resource.selection_changed: selection");
  });

  it("names the changes object when it is empty", () => {
    expect(() =>
      auditEvent(
        "resource.updated",
        {
          workspaceId: "w1",
          actor: { type: "system", id: null },
          targetId: "r1",
          details: { externalId: "1", changes: {} },
        },
        context(),
      ),
    ).toThrow("invalid details for resource.updated: changes");
  });

  it("requires a correlation ID", () => {
    expect(() =>
      auditEvent("user.created", { actor: user, targetId: "u1", details: {} }, context("")),
    ).toThrow("correlation ID is required");
  });

  it("requires a target ID", () => {
    expect(() =>
      auditEvent("user.created", { actor: user, targetId: "", details: {} }, context()),
    ).toThrow("target ID is required");
  });

  it("stores the parsed details, not the caller's object", () => {
    const details = { provider: "github" as const };
    const event = auditEvent("auth.signed_in", { actor: user, targetId: "u1", details }, context());
    expect(event.details).toEqual(details);
    expect(event.details).not.toBe(details);
  });
});
