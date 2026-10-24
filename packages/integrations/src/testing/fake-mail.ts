import { MailError, type MailErrorKind, type MailMessage, type MailPort } from "../mail/port.ts";

/** An in-memory mailbox behind the mail port, for application and jobs tests. */
export interface FakeMail extends MailPort {
  /** Every message sent, in order. */
  readonly sent: readonly MailMessage[];
  /** Messages sent to `to`. */
  inbox(to: string): MailMessage[];
  /** The next send fails with this kind, sending nothing. */
  failNext(kind: MailErrorKind): void;
}

export function createFakeMail(): FakeMail {
  const sent: MailMessage[] = [];
  let failure: MailErrorKind | undefined;
  return {
    sent,
    async send(message) {
      if (failure !== undefined) {
        const kind = failure;
        failure = undefined;
        throw new MailError(kind, `mail send failed (${kind})`);
      }
      sent.push({ ...message });
    },
    inbox(to) {
      return sent.filter((message) => message.to === to).map((message) => ({ ...message }));
    },
    failNext(kind) {
      failure = kind;
    },
  };
}
