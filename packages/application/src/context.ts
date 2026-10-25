import type { Db } from "@sharerepo/db";
import type {
  AlertName,
  AUDIT_ACTIONS,
  AuditAction,
  AuditContext,
  AuditEvent,
} from "@sharerepo/domain";
import { type AlertIds, alert, type Logger } from "@sharerepo/platform";

/** What every service call needs: storage, time, IDs, and the request's correlation ID. */
export interface ServiceContext extends AuditContext {
  readonly db: Db;
  /**
   * Where services raise alert lines (decision 0014), carrying the correlation ID. The Workers
   * always pass their request or job logger; a context without one (tests, scripts) raises none.
   */
  readonly logger?: Logger;
}

/** Raises an alert line through the context's logger, if it has one (decision 0014). */
export function raiseAlert(ctx: ServiceContext, name: AlertName, ids: AlertIds): void {
  if (ctx.logger !== undefined) alert(ctx.logger, name, ids);
}

/** The signed-in user a service acts for. Resolved from the session by the caller. */
export interface UserActor {
  readonly userId: string;
}

export const asAuditActor = (actor: UserActor): AuditEvent["actor"] => ({
  type: "user",
  id: actor.userId,
});

/**
 * The same context with time frozen at one instant, so every row and audit event written by one
 * service call carries the same timestamp, and audit order follows write order.
 */
export function atOneInstant(ctx: ServiceContext): ServiceContext {
  const now = ctx.clock.now();
  return { ...ctx, clock: { now: () => now } };
}

/** Audit actions about one workspace (as opposed to a user's account). */
export type WorkspaceAuditAction = {
  [A in AuditAction]: (typeof AUDIT_ACTIONS)[A]["scope"] extends "workspace" ? A : never;
}[AuditAction];
