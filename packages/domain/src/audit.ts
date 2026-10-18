import { z } from "zod";
import { CONNECTION_STATUSES } from "./connection.ts";
import { IDENTITY_PROVIDERS } from "./identity.ts";
import type { IdGenerator } from "./ids.ts";
import { RESOURCE_SELECTIONS } from "./resource.ts";
import type { Clock, Instant } from "./time.ts";
import { WORKSPACE_ROLES } from "./workspace.ts";

/** Audit events are either about one workspace or about a user's account (decision 0007). */
export const AUDIT_SCOPES = ["workspace", "account"] as const;
export type AuditScope = (typeof AUDIT_SCOPES)[number];

/** Who or what initiated an audited change. */
export const AUDIT_ACTOR_TYPES = ["user", "system", "operator", "provider"] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

/**
 * A persisted audit event (decision 0007). Build one with the action catalog rather than by hand,
 * so `scope`, `target.type` and `details` always match the action's definition.
 */
export interface AuditEvent {
  readonly id: string;
  readonly scope: AuditScope;
  /** Set for workspace-scoped events, null for account-scoped events. */
  readonly workspaceId: string | null;
  readonly actor: { readonly type: AuditActorType; readonly id: string | null };
  readonly action: string;
  readonly target: { readonly type: string; readonly id: string };
  readonly reason: string | null;
  readonly correlationId: string;
  readonly occurredAt: Instant;
  /** Never secrets, tokens or email addresses. */
  readonly details: Readonly<Record<string, unknown>>;
}

interface AuditActionDefinition {
  readonly scope: AuditScope;
  readonly targetType: string;
  readonly details: z.ZodObject;
}

const text = z.string().min(1);
const count = z.number().int().nonnegative();
const provider = z.enum(IDENTITY_PROVIDERS);
const connectionStatus = z.enum(CONNECTION_STATUSES);
const selection = z.enum(RESOURCE_SELECTIONS);

const textChange = z.strictObject({ from: text, to: text });
const booleanChange = z.strictObject({ from: z.boolean(), to: z.boolean() });

/** Mirrors `ResourceChanges` in resource-sync.ts: at least one field, each as from/to. */
const resourceChanges = z
  .strictObject({
    name: textChange.optional(),
    ownerExternalId: textChange.optional(),
    private: booleanChange.optional(),
    archived: booleanChange.optional(),
  })
  .refine((changes) => Object.keys(changes).length > 0);

/** Why a sign-in that authenticated with the provider was refused anyway. */
export const SIGN_IN_REFUSAL_REASONS = ["identity_conflict", "internal_error"] as const;
export type SignInRefusalReason = (typeof SIGN_IN_REFUSAL_REASONS)[number];

// Details schemas are strict: an unknown key is rejected rather than stored, so a secret cannot
// reach the audit trail through an unvetted field.
export const AUDIT_ACTIONS = {
  "user.created": { scope: "account", targetType: "user", details: z.strictObject({}) },
  "identity.linked": {
    scope: "account",
    targetType: "external_identity",
    details: z.strictObject({ provider, externalUserId: text, username: text }),
  },
  "identity.snapshot_updated": {
    scope: "account",
    targetType: "external_identity",
    details: z.strictObject({
      provider,
      externalUserId: text,
      previousUsername: text,
      username: text,
    }),
  },
  "auth.signed_in": {
    scope: "account",
    targetType: "user",
    details: z.strictObject({ provider }),
  },
  "auth.signed_out": { scope: "account", targetType: "user", details: z.strictObject({}) },
  "auth.sign_in_refused": {
    scope: "account",
    targetType: "user",
    details: z.strictObject({ provider, reason: z.enum(SIGN_IN_REFUSAL_REASONS) }),
  },
  "workspace.created": {
    scope: "workspace",
    targetType: "workspace",
    details: z.strictObject({ slug: text, name: text }),
  },
  "workspace.renamed": {
    scope: "workspace",
    targetType: "workspace",
    details: z.strictObject({ previousName: text, name: text }),
  },
  "membership.added": {
    scope: "workspace",
    targetType: "user",
    details: z.strictObject({ role: z.enum(WORKSPACE_ROLES) }),
  },
  "connection.intent_created": {
    scope: "workspace",
    targetType: "connection_intent",
    details: z.strictObject({ provider }),
  },
  "connection.created": {
    scope: "workspace",
    targetType: "connection",
    details: z.strictObject({ provider, installationId: text, accountLogin: text }),
  },
  "connection.status_changed": {
    scope: "workspace",
    targetType: "connection",
    details: z
      .strictObject({ previousStatus: connectionStatus, status: connectionStatus })
      // A transition must change something; the issue names the new value's field.
      .refine((d) => d.previousStatus !== d.status, { path: ["status"] }),
  },
  // Written by every resync, so its bookkeeping (last_synced_at) is audited too.
  "connection.synced": {
    scope: "workspace",
    targetType: "connection",
    details: z.strictObject({ discovered: count, updated: count, removed: count }),
  },
  "resource.discovered": {
    scope: "workspace",
    targetType: "resource",
    details: z.strictObject({ externalId: text, name: text, private: z.boolean() }),
  },
  "resource.updated": {
    scope: "workspace",
    targetType: "resource",
    details: z.strictObject({ externalId: text, changes: resourceChanges }),
  },
  "resource.selection_changed": {
    scope: "workspace",
    targetType: "resource",
    details: z
      .strictObject({ externalId: text, previousSelection: selection, selection })
      .refine((d) => d.previousSelection !== d.selection, { path: ["selection"] }),
  },
} as const satisfies Record<string, AuditActionDefinition>;

export type AuditAction = keyof typeof AUDIT_ACTIONS;
type Definition<A extends AuditAction> = (typeof AUDIT_ACTIONS)[A];
export type AuditDetails<A extends AuditAction> = z.input<Definition<A>["details"]>;

/** A workspace ID is required for workspace-scoped actions and not allowed for account-scoped ones. */
type WorkspaceField<A extends AuditAction> = Definition<A>["scope"] extends "workspace"
  ? { readonly workspaceId: string }
  : { readonly workspaceId?: never };

export type AuditEventInput<A extends AuditAction> = WorkspaceField<A> & {
  readonly actor: AuditEvent["actor"];
  readonly targetId: string;
  readonly reason?: string;
  readonly details: AuditDetails<A>;
};

export interface AuditContext {
  readonly ids: IdGenerator;
  readonly clock: Clock;
  readonly correlationId: string;
}

/**
 * Builds an audit event for a catalog action. Invalid input is a programmer error and throws;
 * error messages name fields and keys but never echo values.
 */
export function auditEvent<A extends AuditAction>(
  action: A,
  input: AuditEventInput<A>,
  context: AuditContext,
): AuditEvent {
  if (!Object.hasOwn(AUDIT_ACTIONS, action)) throw new Error(`unknown audit action: ${action}`);
  const definition: AuditActionDefinition = AUDIT_ACTIONS[action];
  const { workspaceId } = input as { readonly workspaceId?: string };

  if (definition.scope === "workspace" && !workspaceId) {
    throw new Error(`${action} is workspace-scoped and needs a workspace ID`);
  }
  if (definition.scope === "account" && workspaceId !== undefined) {
    throw new Error(`${action} is account-scoped and takes no workspace ID`);
  }
  if (input.actor.type !== "system" && !input.actor.id) {
    throw new Error(`audit actor of type ${input.actor.type} needs an ID`);
  }
  if (!input.targetId) throw new Error("audit target ID is required");
  if (!context.correlationId) throw new Error("audit correlation ID is required");

  const parsed = definition.details.safeParse(input.details);
  if (!parsed.success) {
    // Each issue is named by its dotted path, for example `changes.name.to`.
    const fields = parsed.error.issues.flatMap((issue) =>
      issue.code === "unrecognized_keys"
        ? issue.keys.map((key) => [...issue.path, key].join("."))
        : [issue.path.join(".")],
    );
    throw new Error(`invalid details for ${action}: ${fields.join(", ")}`);
  }

  return {
    id: context.ids.next(),
    scope: definition.scope,
    workspaceId: workspaceId ?? null,
    actor: { type: input.actor.type, id: input.actor.id },
    action,
    target: { type: definition.targetType, id: input.targetId },
    reason: input.reason ?? null,
    correlationId: context.correlationId,
    occurredAt: context.clock.now(),
    details: parsed.data,
  };
}
