import type { Instant } from "./time.ts";

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
