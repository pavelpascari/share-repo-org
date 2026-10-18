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

/** One valid details object per action; every field is required and non-empty. */
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
  "workspace.created": { slug: "acme", name: "Acme" },
  "workspace.renamed": { previousName: "Acme", name: "Acme Labs" },
  "membership.added": { role: "owner" },
} as const satisfies { [A in AuditAction]: AuditDetails<A> };

const ACTIONS = Object.keys(VALID_DETAILS) as AuditAction[];

describe("audit action catalog", () => {
  it("defines exactly the Phase 1 actions", () => {
    expect(Object.keys(AUDIT_ACTIONS).sort()).toEqual([...ACTIONS].sort());
  });

  it.each([
    ["user.created", "account", "user"],
    ["identity.linked", "account", "external_identity"],
    ["identity.snapshot_updated", "account", "external_identity"],
    ["auth.signed_in", "account", "user"],
    ["auth.signed_out", "account", "user"],
    ["workspace.created", "workspace", "workspace"],
    ["workspace.renamed", "workspace", "workspace"],
    ["membership.added", "workspace", "user"],
  ] as const)("%s is %s-scoped and targets a %s", (action, scope, targetType) => {
    expect(AUDIT_ACTIONS[action].scope).toBe(scope);
    expect(AUDIT_ACTIONS[action].targetType).toBe(targetType);
  });

  describe.each(ACTIONS)("%s details", (action) => {
    const schema = AUDIT_ACTIONS[action].details;
    const valid: Readonly<Record<string, string>> = VALID_DETAILS[action];

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

    it.each(Object.keys(valid))("reject an empty %s", (key) => {
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
  ] as const)("%s rejects %s %j", (action, key, value) => {
    const details = { ...VALID_DETAILS[action], [key]: value };
    expect(AUDIT_ACTIONS[action].details.safeParse(details).success).toBe(false);
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
