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

/** The fields every `provider.mutation_*` event carries. */
const MUTATION = {
  mutationId: "m1",
  operation: "invite",
  resourceId: "r1",
  subjectId: "s1",
  resourceExternalId: "1296269",
  subjectExternalId: "583231",
  accessLevel: "write",
  entitlementIds: ["e1"],
} as const;

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
  "offer.created": { name: "Pro", version: 1, gracePeriodDays: 7, items: 1, accesses: 2 },
  "offer.updated": { version: 3, previousVersion: 2, changes: ["name", "accesses"] },
  "offer.archived": { version: 4 },
  "subject.created": { provider: "github", externalSubjectId: "583231", login: "octocat" },
  "subject.login_updated": {
    provider: "github",
    externalSubjectId: "583231",
    previousLogin: "octocat",
    login: "octocat-renamed",
  },
  "customer.created": { source: "simulated", externalCustomerId: "ctm_1" },
  "customer.linked": { previousSubjectId: "s1", subjectId: "s2" },
  "subscription.recorded": {
    source: "simulated",
    externalSubscriptionId: "sub_1",
    state: "active",
  },
  "subscription.updated": {
    previousState: "active",
    state: "past_due",
    sourceUpdatedAt: 1_700_000_000_000,
  },
  "entitlement.created": {
    subjectId: "s1",
    resourceId: "r1",
    accessLevel: "write",
    subscriptionId: "sub1",
    offerId: "o1",
    offerVersion: 2,
    policyVersion: 1,
    validUntil: 1_700_000_000_000,
    reason: "cancel_scheduled",
  },
  "entitlement.updated": {
    validUntil: { from: null, to: 1_700_000_000_000 },
    reason: "cancel_scheduled",
    offerVersion: 2,
    policyVersion: 1,
  },
  "entitlement.ended": { state: "expired", reason: "grace_expired" },
  "simulation.subscription_changed": { action: "cancel_now", state: "canceled" },
  "grant.observed": {
    resourceId: "r1",
    subjectId: "s1",
    from: { state: "provisioning", managed: true, indirect: false, accessLevel: "write" },
    to: { state: "pending_invitation", managed: true, indirect: false, accessLevel: "write" },
  },
  "provider.mutation_attempted": MUTATION,
  "provider.mutation_succeeded": MUTATION,
  "provider.mutation_failed": {
    ...MUTATION,
    errorCode: "rate_limited",
    retryClass: "rate_limited",
  },
  "provider.mutation_resolved": { ...MUTATION, state: "pending_invitation" },
  "reconciliation.requested": { resourceId: "r1", kind: "check" },
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
    ["offer.created", "workspace", "offer"],
    ["offer.updated", "workspace", "offer"],
    ["offer.archived", "workspace", "offer"],
    ["subject.created", "workspace", "subject"],
    ["subject.login_updated", "workspace", "subject"],
    ["customer.created", "workspace", "customer"],
    ["customer.linked", "workspace", "customer"],
    ["subscription.recorded", "workspace", "subscription"],
    ["subscription.updated", "workspace", "subscription"],
    ["entitlement.created", "workspace", "entitlement"],
    ["entitlement.updated", "workspace", "entitlement"],
    ["entitlement.ended", "workspace", "entitlement"],
    ["simulation.subscription_changed", "workspace", "simulated_subscription"],
    ["grant.observed", "workspace", "grant"],
    ["provider.mutation_attempted", "workspace", "grant"],
    ["provider.mutation_succeeded", "workspace", "grant"],
    ["provider.mutation_failed", "workspace", "grant"],
    ["provider.mutation_resolved", "workspace", "grant"],
    ["reconciliation.requested", "workspace", "resource"],
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
    ["offer.created", "version", 0],
    ["offer.created", "gracePeriodDays", -1],
    ["offer.created", "gracePeriodDays", 31],
    ["offer.created", "gracePeriodDays", 1.5],
    ["offer.created", "items", -1],
    ["offer.created", "accesses", 0.5],
    ["offer.updated", "changes", []],
    ["offer.updated", "changes", ["price"]],
    ["offer.updated", "version", 2],
    ["offer.updated", "version", 4],
    ["offer.updated", "previousVersion", 0],
    ["offer.archived", "version", 0],
    ["offer.archived", "version", 1.5],
    ["subject.created", "provider", "gitlab"],
    ["subject.login_updated", "provider", "gitlab"],
    ["subject.login_updated", "login", "octocat"],
    ["subject.login_updated", "previousLogin", ""],
    ["customer.created", "source", "stripe"],
    ["customer.linked", "subjectId", "s1"],
    ["customer.linked", "subjectId", ""],
    ["subscription.recorded", "source", "stripe"],
    ["subscription.recorded", "state", "unpaid"],
    ["subscription.updated", "previousState", "unpaid"],
    ["subscription.updated", "state", "unpaid"],
    ["subscription.updated", "sourceUpdatedAt", -1],
    ["subscription.updated", "sourceUpdatedAt", 1.5],
    ["entitlement.created", "accessLevel", "admin"],
    ["entitlement.created", "offerVersion", 0],
    ["entitlement.created", "policyVersion", 0],
    ["entitlement.created", "validUntil", -1],
    ["entitlement.created", "reason", "because"],
    ["entitlement.updated", "validUntil", { from: null }],
    ["entitlement.updated", "validUntil", { from: null, to: 1.5 }],
    ["entitlement.updated", "validUntil", { from: null, to: 1, token: "x" }],
    ["entitlement.updated", "reason", "because"],
    ["entitlement.updated", "offerVersion", 0],
    ["entitlement.updated", "policyVersion", 0],
    ["entitlement.ended", "state", "active"],
    ["entitlement.ended", "reason", "because"],
    ["simulation.subscription_changed", "state", "unpaid"],
    ["grant.observed", "from", { state: "active", managed: true, indirect: false }],
    ["grant.observed", "from", { ...VALID_DETAILS["grant.observed"].to }],
    [
      "grant.observed",
      "to",
      { state: "granted", managed: true, indirect: false, accessLevel: "write" },
    ],
    [
      "grant.observed",
      "to",
      { state: "active", managed: 1, indirect: false, accessLevel: "write" },
    ],
    [
      "grant.observed",
      "to",
      { state: "active", managed: true, indirect: false, accessLevel: "admin" },
    ],
    [
      "grant.observed",
      "to",
      { state: "active", managed: true, indirect: false, accessLevel: "write", login: "x" },
    ],
    ["provider.mutation_attempted", "operation", "delete_repository"],
    ["provider.mutation_attempted", "accessLevel", "admin"],
    ["provider.mutation_attempted", "entitlementIds", [""]],
    ["provider.mutation_attempted", "entitlementIds", "e1"],
    ["provider.mutation_succeeded", "operation", "delete_repository"],
    ["provider.mutation_failed", "errorCode", "boom"],
    ["provider.mutation_failed", "retryClass", "later"],
    ["provider.mutation_resolved", "state", "granted"],
    ["reconciliation.requested", "kind", "sync"],
    ["reconciliation.requested", "grantId", ""],
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

describe("offer, commerce and entitlement details", () => {
  it.each([
    ["offer.created", { name: "Pro", version: 1, gracePeriodDays: 0, items: 0, accesses: 1 }],
    ["offer.created", { name: "Pro", version: 1, gracePeriodDays: 30, items: 2, accesses: 1 }],
    ["offer.updated", { version: 2, previousVersion: 1, changes: ["gracePeriodDays", "items"] }],
    ["customer.linked", { previousSubjectId: null, subjectId: "s1" }],
    ["customer.linked", { previousSubjectId: "s1", subjectId: null }],
    ["subscription.updated", { previousState: "active", state: "active", sourceUpdatedAt: 0 }],
    [
      "entitlement.created",
      { ...VALID_DETAILS["entitlement.created"], validUntil: null, accessLevel: "read" },
    ],
    [
      "entitlement.updated",
      { ...VALID_DETAILS["entitlement.updated"], validUntil: { from: 5, to: null } },
    ],
    ["entitlement.ended", { state: "revoked", reason: "paused" }],
  ] as const)("%s accepts %j", (action, details) => {
    expect(AUDIT_ACTIONS[action].details.parse(details)).toEqual(details);
  });

  it("customer.linked refuses an unchanged link, unlinked included", () => {
    const schema = AUDIT_ACTIONS["customer.linked"].details;
    expect(schema.safeParse({ previousSubjectId: null, subjectId: null }).success).toBe(false);
  });

  it("names the field of a refused transition", () => {
    const system = { type: "system", id: null } as const;
    expect(() =>
      auditEvent(
        "offer.updated",
        {
          workspaceId: "w1",
          actor: system,
          targetId: "o1",
          details: { version: 3, previousVersion: 3, changes: ["name"] },
        },
        context(),
      ),
    ).toThrow("invalid details for offer.updated: version");
    expect(() =>
      auditEvent(
        "customer.linked",
        {
          workspaceId: "w1",
          actor: system,
          targetId: "c1",
          details: { previousSubjectId: "s1", subjectId: "s1" },
        },
        context(),
      ),
    ).toThrow("invalid details for customer.linked: subjectId");
  });
});

describe("provisioning details", () => {
  const observed = (state: string, managed: boolean, indirect: boolean, accessLevel: string) => ({
    state,
    managed,
    indirect,
    accessLevel,
  });

  it.each([
    ["a new grant", null, observed("active", false, true, "write")],
    [
      "a state change",
      observed("active", true, false, "write"),
      observed("absent", true, false, "write"),
    ],
    [
      "an ownership change",
      observed("active", true, false, "write"),
      observed("active", false, false, "write"),
    ],
    [
      "an indirectness change",
      observed("active", false, false, "write"),
      observed("active", false, true, "write"),
    ],
    [
      "a level change",
      observed("active", false, false, "read"),
      observed("active", false, false, "write"),
    ],
  ])("grant.observed accepts %s", (_, from, to) => {
    const details = { resourceId: "r1", subjectId: "s1", from, to };
    expect(AUDIT_ACTIONS["grant.observed"].details.parse(details)).toEqual(details);
  });

  it.each([
    [
      "provider.mutation_attempted",
      { ...MUTATION, operation: "cancel_invitation", entitlementIds: [] },
    ],
    ["provider.mutation_failed", { ...MUTATION, errorCode: "suspended", retryClass: null }],
    [
      "provider.mutation_failed",
      { ...MUTATION, errorCode: "repository_not_found", retryClass: null },
    ],
    [
      "provider.mutation_failed",
      { ...MUTATION, errorCode: "provider_unavailable", retryClass: "retryable" },
    ],
    ["reconciliation.requested", { resourceId: "r1", grantId: "g1", kind: "retry" }],
  ] as const)("%s accepts %j", (action, details) => {
    expect(AUDIT_ACTIONS[action].details.parse(details)).toEqual(details);
  });

  it("names the field of an unchanged observation", () => {
    const same = observed("active", true, false, "write");
    expect(() =>
      auditEvent(
        "grant.observed",
        {
          workspaceId: "w1",
          actor: { type: "system", id: null },
          targetId: "g1",
          details: { resourceId: "r1", subjectId: "s1", from: same, to: same } as never,
        },
        context(),
      ),
    ).toThrow("invalid details for grant.observed: to");
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
