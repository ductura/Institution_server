// Idle expiry of a session at the HTTP edge (SRV-1401, DAN-296, plan M1.6).
// A session with no accepted request for longer than its institution's limit
// (default 30 minutes) is refused with 401 session_idle_expired until its
// user signs in again. The database keeps its own ceiling of two hours
// (app.current_actor(), migration 20261101200000_session_idle.sql), so this
// tracker only ever shortens a session, never lengthens it.
//
// The tracker lives in the memory of one web process, as the WebAuthn
// challenges do (docs/server-map.md): the key is the SHA-256 of the token,
// never the token, and the clock is monotonic, so a wall clock set back does
// not revive an idle session.
import { createHash } from "node:crypto";

/** The limit when the institution has not chosen one (M1.6). */
export const DEFAULT_SESSION_IDLE_MINUTES = 30;
/** Bounds of network.session_idle_minutes in the settings catalogue (D-298). */
export const SESSION_IDLE_MIN_MINUTES = 15;
export const SESSION_IDLE_MAX_MINUTES = 120;
/**
 * Entries kept at most. Past it the least recently active go first; an entry
 * idle for SESSION_IDLE_MAX_MINUTES goes in any case, because by then the
 * database refuses the session on its own.
 */
export const IDLE_TRACKER_CAPACITY = 100_000;

const MINUTE_MS = 60_000;
const MAX_IDLE_MS = SESSION_IDLE_MAX_MINUTES * MINUTE_MS;

/** The limit of the institution behind a token, in minutes; null when it has none. */
export type IdleMinutesFor = (token: string) => Promise<number | null>;

export type IdleVerdict = "active" | "expired";

export type IdleTracker = {
  /** Whether the session behind `token` is past its limit. Never throws. */
  check(token: string): Promise<IdleVerdict>;
  /** Records an accepted request; an expired session stays expired. */
  touch(token: string): void;
  /** Entries held now (for tests and metrics). */
  size(): number;
};

/**
 * The limit to apply for a configured value: an integer from
 * SESSION_IDLE_MIN_MINUTES to SESSION_IDLE_MAX_MINUTES, else the default.
 */
export function idleLimitMinutes(value: unknown): number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= SESSION_IDLE_MIN_MINUTES &&
    value <= SESSION_IDLE_MAX_MINUTES
    ? value
    : DEFAULT_SESSION_IDLE_MINUTES;
}

const keyOf = (token: string): string => createHash("sha256").update(token).digest("base64url");

type Entry = { lastSeen: number; expired: boolean };

/**
 * `now` is a monotonic clock in milliseconds (default performance.now()).
 * `minutesFor` reads the institution's limit; without it, or when it fails
 * or gives a value out of bounds, the limit is DEFAULT_SESSION_IDLE_MINUTES.
 * A token the tracker has not seen is active: its idle time starts with its
 * first accepted request here. Exactly the limit is already expired, as in
 * the database.
 */
export function createIdleTracker(
  options: {
    readonly now?: () => number;
    readonly minutesFor?: IdleMinutesFor;
    readonly capacity?: number;
  } = {},
): IdleTracker {
  const now = options.now ?? (() => performance.now());
  const capacity = options.capacity ?? IDLE_TRACKER_CAPACITY;
  if (!Number.isInteger(capacity) || capacity < 1) throw new Error("capacity must be at least 1");
  // Insertion order is activity order: touch moves an entry to the end.
  const entries = new Map<string, Entry>();

  const limitMs = async (token: string): Promise<number> => {
    if (options.minutesFor === undefined) return DEFAULT_SESSION_IDLE_MINUTES * MINUTE_MS;
    try {
      return idleLimitMinutes(await options.minutesFor(token)) * MINUTE_MS;
    } catch {
      return DEFAULT_SESSION_IDLE_MINUTES * MINUTE_MS;
    }
  };

  const prune = (at: number): void => {
    for (const [key, entry] of entries) {
      if (entries.size <= capacity && at - entry.lastSeen < MAX_IDLE_MS) return;
      entries.delete(key);
    }
  };

  return {
    async check(token) {
      const key = keyOf(token);
      const seen = entries.get(key);
      if (seen === undefined) return "active";
      if (seen.expired) return "expired";
      const limit = await limitMs(token);
      // Read again: a touch or a prune may have run while the limit was read.
      const entry = entries.get(key);
      if (entry === undefined) return "active";
      if (entry.expired) return "expired";
      if (now() - entry.lastSeen >= limit) {
        entry.expired = true;
        return "expired";
      }
      return "active";
    },
    touch(token) {
      const key = keyOf(token);
      const at = now();
      const entry = entries.get(key);
      if (entry?.expired === true) return;
      entries.delete(key);
      entries.set(key, { lastSeen: at, expired: false });
      prune(at);
    },
    size: () => entries.size,
  };
}
