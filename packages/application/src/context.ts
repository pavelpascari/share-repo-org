import type { Db } from "@sharerepo/db";
import type { AuditContext, AuditEvent } from "@sharerepo/domain";

/** What every service call needs: storage, time, IDs, and the request's correlation ID. */
export interface ServiceContext extends AuditContext {
  readonly db: Db;
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
