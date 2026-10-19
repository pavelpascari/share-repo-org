import type { RouterContextProvider } from "react-router";
import type { JobMessage } from "../workers/webhooks.ts";
import { cloudflareContext } from "./context.ts";

/**
 * Hands committed work to the jobs Worker, best effort, the way the webhook path does: the
 * outbox row is already durable, so a failed send only delays the work until the cron drain
 * runs it. Never fails the request; logs a classification only.
 */
export function enqueueJob(context: Readonly<RouterContextProvider>, message: JobMessage): void {
  const { env, ctx, logger } = context.get(cloudflareContext);
  ctx.waitUntil(
    Promise.resolve()
      .then(() => env.EVENTS.send(message))
      .catch((error: unknown) =>
        logger.warn("queue send failed; the outbox drain will deliver", {
          outboxId: message.outboxId,
          kind: message.kind,
          errorName: error instanceof Error ? error.name : "unknown",
        }),
      ),
  );
}
