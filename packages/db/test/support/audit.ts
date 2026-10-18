import type { AuditEvent } from "@sharerepo/domain";
import { T0, uniqueId } from "./rows.ts";

// Hand-built events: these tests exercise storage, not the domain's action catalog.

export function accountEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: uniqueId("aud"),
    scope: "account",
    workspaceId: null,
    actor: { type: "user", id: "usr_actor" },
    action: "test.account_event",
    target: { type: "user", id: "usr_target" },
    reason: null,
    correlationId: uniqueId("corr"),
    occurredAt: T0,
    details: {},
    ...overrides,
  };
}

export function workspaceEvent(
  workspaceId: string,
  overrides: Partial<AuditEvent> = {},
): AuditEvent {
  return accountEvent({
    scope: "workspace",
    workspaceId,
    action: "test.workspace_event",
    target: { type: "workspace", id: workspaceId },
    ...overrides,
  });
}

export async function auditCount(db: D1Database, correlationId: string): Promise<number> {
  const row = await db
    .prepare("SELECT count(*) AS n FROM audit_events WHERE correlation_id = ?")
    .bind(correlationId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
