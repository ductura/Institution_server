// Public interface of identity/session: idle expiry of a session (SRV-1401).
export {
  createIdleTracker,
  DEFAULT_SESSION_IDLE_MINUTES,
  IDLE_TRACKER_CAPACITY,
  idleLimitMinutes,
  SESSION_IDLE_MAX_MINUTES,
  SESSION_IDLE_MIN_MINUTES,
  type IdleMinutesFor,
  type IdleTracker,
  type IdleVerdict,
} from "./idle.ts";
