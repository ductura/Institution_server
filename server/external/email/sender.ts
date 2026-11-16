// The email port and its guard (S-1E-c, DAN-837; server/metrics
// createExternalCaller). Sending is not idempotent, so a message goes at most
// once: no retry, and a timeout says "not known to be sent", never "sent".
// The address, template and values exist only for the call; nothing of them
// goes into the event or the error.
import type { ExternalCaller } from "../../metrics/index.ts";

export type EmailMessage = {
  readonly to: string;
  readonly template: string;
  readonly values: Readonly<Record<string, string>>;
};

export type EmailSendAnswer = { status: "sent" } | { status: "unavailable" };

/** What an adapter (Mailpit locally, an EU service in production) implements. */
export type EmailSender = {
  send(message: EmailMessage, signal: AbortSignal): Promise<EmailSendAnswer>;
};

export type EmailError = { readonly code: string; readonly messageKey: string };
export type EmailSendResult = { ok: true } | { ok: false; error: EmailError };

/** Croatian text under `email` in locales/hr.json (docs/CODE_STYLE.md §8). */
export const EMAIL_TIMEOUT: EmailError = { code: "EMAIL_TIMEOUT", messageKey: "email.timeout" };
export const EMAIL_UNAVAILABLE: EmailError = {
  code: "EMAIL_UNAVAILABLE",
  messageKey: "email.unavailable",
};
export const EMAIL_ERRORS: readonly EmailError[] = [EMAIL_TIMEOUT, EMAIL_UNAVAILABLE];

export type GuardedEmail = { send(message: EmailMessage): Promise<EmailSendResult> };

/** `sender` under `caller` (made with service "email"). */
export function guardEmail(sender: EmailSender, caller: ExternalCaller): GuardedEmail {
  return {
    async send(message) {
      const result = await caller.call("send", (signal) => sender.send(message, signal), {
        failed: (answer) => answer.status !== "sent",
      });
      if (result.ok) return { ok: true };
      return { ok: false, error: result.failure === "timeout" ? EMAIL_TIMEOUT : EMAIL_UNAVAILABLE };
    },
  };
}
