// Public interface of server/external/email; other areas import only this file.
export { EMAIL_ROUTES } from "./routes.ts";
export { EMAIL_SCHEMAS } from "./schemas.ts";
export type { EmailService } from "./service.ts";
export {
  EMAIL_ERRORS,
  EMAIL_TIMEOUT,
  EMAIL_UNAVAILABLE,
  guardEmail,
  type EmailError,
  type EmailMessage,
  type EmailSendAnswer,
  type EmailSender,
  type EmailSendResult,
  type GuardedEmail,
} from "./sender.ts";
