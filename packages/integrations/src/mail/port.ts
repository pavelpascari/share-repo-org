import { z } from "zod";
import type { MailTransportConfig } from "./config.ts";

/** One transactional email (a claim link). Addresses and bodies are never logged. */
export interface MailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

/** Sends claim emails (decision 0012). Failures are `MailError`s. */
export interface MailPort {
  send(message: MailMessage): Promise<void>;
}

/**
 * `transient`: worth retrying (network, timeout, 5xx, rate limits, unknown failures).
 * `rejected`: the message itself was refused (invalid or disallowed recipient or sender, 4xx).
 */
export const MAIL_ERROR_KINDS = ["transient", "rejected"] as const;
export type MailErrorKind = (typeof MAIL_ERROR_KINDS)[number];

/** Never carries an address, subject or body; only the transport and a provider code. */
export class MailError extends Error {
  readonly kind: MailErrorKind;
  /** The binding's `code` or the capture's HTTP status, when well formed. */
  readonly providerCode: string | undefined;

  constructor(kind: MailErrorKind, message: string, providerCode?: string) {
    super(message);
    this.name = "MailError";
    this.kind = kind;
    this.providerCode = providerCode;
  }
}

export interface MailPortOptions {
  /** The sender, on the onboarded sending domain (for example `claims@sharerepo.org`). */
  readonly from: string;
  /** For the capture transport. */
  readonly fetch: typeof fetch;
}

/** How long a capture POST may take before it is aborted and classified `transient`. */
export const MAIL_REQUEST_TIMEOUT_MS = 20_000;

/**
 * Codes from the binding that mean the message itself was refused. Cloudflare documents that
 * `send` throws an `Error` with a `code`, but not the code list (research § 7; UNCONFIRMED), so
 * this matches by wording and treats anything else as `transient`.
 */
const REJECTED_CODE = /invalid|not_?allowed|unverified|forbidden|recipient|sender|too_?large/i;
const PROVIDER_CODE = /^[A-Za-z0-9_.-]{1,64}$/;

const message = z.object({
  to: z
    .string()
    .min(3)
    .max(254)
    .regex(/^[^\s@]+@[^\s@]+$/),
  subject: z.string().min(1).max(998),
  text: z.string().min(1),
  html: z.string().min(1),
});

function validated(input: MailMessage): MailMessage {
  if (!message.safeParse(input).success)
    throw new MailError("rejected", "mail refused: invalid message");
  return input;
}

/** The mail port for a configured transport (`parseMailConfig`). */
export function createMailPort(transport: MailTransportConfig, options: MailPortOptions): MailPort {
  const { from } = options;
  if (transport.kind === "binding") {
    const { binding } = transport;
    return {
      async send(input) {
        const { to, subject, html, text } = validated(input);
        try {
          await binding.send({ to, from, subject, html, text });
        } catch (error) {
          const code = (error as { code?: unknown } | null)?.code;
          const providerCode =
            typeof code === "string" && PROVIDER_CODE.test(code) ? code : undefined;
          const kind =
            providerCode !== undefined && REJECTED_CODE.test(providerCode)
              ? "rejected"
              : "transient";
          throw new MailError(kind, `mail send failed (${kind})`, providerCode);
        }
      },
    };
  }
  const send = options.fetch;
  return {
    async send(input) {
      const { to, subject, html, text } = validated(input);
      let response: Response;
      try {
        response = await send(transport.url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ to, from, subject, text, html }),
          signal: AbortSignal.timeout(MAIL_REQUEST_TIMEOUT_MS),
        });
      } catch {
        throw new MailError("transient", "mail capture failed: network error");
      }
      if (response.ok) return;
      const kind = response.status < 500 && response.status !== 429 ? "rejected" : "transient";
      throw new MailError(
        kind,
        `mail capture failed with status ${response.status}`,
        String(response.status),
      );
    },
  };
}
