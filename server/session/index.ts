// Public interface of the session area: session token and cookie, principal,
// ended-session marks, activity and back-channel logout. Other areas import
// from here, never from the files next to it. Ported from Ductus
// src/server/auth at d52a92c3 (S-0.18, DAN-731).
export { counted, pageActivity, recordActivity, type Schedule } from "./activity.ts";
export {
  backchannelLogout,
  MAX_BACKCHANNEL_BODY_BYTES,
  type BackchannelDeps,
} from "./backchannel.ts";
export { ENDED_MARK_COOKIE, liveSessionToken, type CookieReader } from "./ended-mark.ts";
export type {
  ActorReader,
  ActorTransaction,
  BackchannelLogout,
  BackchannelLogoutInput,
  BackchannelLogoutResult,
  CurrentActor,
  CurrentActorWithInstitution,
  WithActor,
} from "../database/index.ts";
export {
  PRINCIPAL_SCOPE_LABEL,
  principalScope,
  SESSION_TAG_LABEL,
  sessionPrincipal,
  sessionPrincipalWithInstitution,
  sessionTag,
  type SessionPrincipal,
  type SessionPrincipalWithInstitution,
} from "./principal.ts";
export { DEFAULT_RETURN_TO, safeReturnTo } from "./return-to.ts";
export {
  clearedSessionCookieOptions,
  hashSessionToken,
  newSessionToken,
  SESSION_COOKIE_NAME,
  sessionCookieOptions,
  type SessionCookieOptions,
} from "./session-token.ts";
