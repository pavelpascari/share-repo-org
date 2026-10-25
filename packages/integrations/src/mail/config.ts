import { parseEnv } from "@sharerepo/platform";
import { z } from "zod";

/**
 * How claim emails are sent (decision 0012): Cloudflare's `send_email` binding where the sending
 * domain is onboarded, an HTTP capture by the E2E fake, or nothing, in which case claiming by
 * email is reported as unavailable.
 */
/**
 * Cloudflare's `send_email` binding, structurally: integrations also compile without the Workers
 * ambient types (scripts/). The mail port (Phase 5 plan, T3) narrows the message type.
 */
export interface SendEmailBinding {
  send(message: unknown): Promise<unknown>;
}

export type MailTransportConfig =
  | { readonly kind: "binding"; readonly binding: SendEmailBinding }
  | { readonly kind: "capture"; readonly url: string };

const mailEnvSchema = z
  .object({
    ENVIRONMENT: z.enum(["development", "e2e", "production"]),
    EMAIL: z.custom<SendEmailBinding>(isSendEmailBinding).optional(),
    MAIL_CAPTURE_URL: z.url({ protocol: /^https?$/ }).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.ENVIRONMENT !== "e2e" && env.MAIL_CAPTURE_URL !== undefined) {
      ctx.addIssue({ code: "custom", path: ["MAIL_CAPTURE_URL"], message: "e2e only" });
    }
  });

/**
 * The mail transport, or null when none is configured. `MAIL_CAPTURE_URL` is accepted only when
 * ENVIRONMENT is `e2e` (decision 0006) and wins over a binding there. Errors name keys and issue
 * codes, never values.
 */
export function parseMailConfig(env: unknown): MailTransportConfig | null {
  const { EMAIL, MAIL_CAPTURE_URL } = parseEnv(mailEnvSchema, env);
  if (MAIL_CAPTURE_URL !== undefined) return { kind: "capture", url: MAIL_CAPTURE_URL };
  if (EMAIL !== undefined) return { kind: "binding", binding: EMAIL };
  return null;
}

function isSendEmailBinding(value: unknown): value is SendEmailBinding {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { send?: unknown }).send === "function"
  );
}
