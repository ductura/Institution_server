import { randomBytes as nodeRandomBytes, timingSafeEqual } from "node:crypto";

import { hashSessionToken } from "./session-token.ts";

// One-time WebAuthn challenges (S-1E-g, DAN-840-2a): 32 random bytes for one
// ceremony of one session. They live in the memory of this process, on the
// assumption of one web process (docs/server-map.md, session); a restart
// forgets them and the client asks again. The first take spends a challenge,
// successful or not, and it is gone at its expiry; the clock is injected.

export type ChallengePurpose = "registration" | "assertion";

export type ChallengeStoreOptions = {
  /** Milliseconds since the epoch, as clock.nowMs. */
  readonly now: () => number;
  /** 1 to 600 000 ms, the bound of timeoutMs in auth.webauthn-challenge.post. */
  readonly ttlMs: number;
  readonly capacity?: number;
  readonly randomBytes?: (size: number) => Uint8Array;
};

/** `expiresAt` in milliseconds since the epoch. */
export type IssuedChallenge = { readonly challenge: string; readonly expiresAt: number };

export type ChallengeStore = {
  /** Replaces this session's challenge for the purpose; null when the clock fails. */
  issue(sessionKey: string, purpose: ChallengePurpose): IssuedChallenge | null;
  /** "ok" once for a live challenge of this session and purpose, else "invalid". */
  take(sessionKey: unknown, purpose: unknown, challenge: unknown): "ok" | "invalid";
};

/** The key of a session in the store: the base64url SHA-256 of its token, never the token (DAN-840-3c). */
export function challengeSessionKey(token: string): string {
  return hashSessionToken(token).toString("base64url");
}

/** Most challenges held at once; when full, expired ones go first, then the oldest. */
export const CHALLENGE_CAPACITY = 10_000;
export const MAX_CHALLENGE_TTL_MS = 600_000;
const CHALLENGE_BYTES = 32;
// 43 base64url characters: a challenge, and the base64url SHA-256 of a session token.
const KEY_PATTERN = /^[A-Za-z0-9_-]{43}(?![\s\S])/u;
const PURPOSES: readonly unknown[] = ["registration", "assertion"];

type Entry = { readonly text: Buffer; readonly issuedAt: number; readonly expiresAt: number };

function readClock(now: () => number): number | null {
  try {
    const value = now();
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

const wholeIn = (value: number, max: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= max;

export function createChallengeStore(options: ChallengeStoreOptions): ChallengeStore {
  const { now, ttlMs, capacity = CHALLENGE_CAPACITY } = options;
  if (!wholeIn(ttlMs, MAX_CHALLENGE_TTL_MS)) throw new RangeError("ttlMs out of range");
  if (!wholeIn(capacity, CHALLENGE_CAPACITY)) throw new RangeError("capacity out of range");
  const random = options.randomBytes ?? nodeRandomBytes;
  // A Map keeps insertion order, so the first key is the oldest; no key reaches a prototype.
  const entries = new Map<string, Entry>();
  const keyOf = (sessionKey: unknown, purpose: unknown): string | null =>
    typeof sessionKey === "string" && KEY_PATTERN.test(sessionKey) && PURPOSES.includes(purpose)
      ? `${String(purpose)}:${sessionKey}`
      : null;

  return {
    issue(sessionKey, purpose) {
      const key = keyOf(sessionKey, purpose);
      if (key === null) throw new TypeError("a session key and a purpose are required");
      const at = readClock(now);
      if (at === null) return null;
      const bytes = Buffer.from(random(CHALLENGE_BYTES));
      if (bytes.length !== CHALLENGE_BYTES) throw new RangeError("randomBytes gave the wrong size");
      const challenge = bytes.toString("base64url");
      entries.delete(key);
      if (entries.size >= capacity) {
        // Expired ones first: a clock that went back breaks insertion order as expiry order.
        for (const [old, entry] of entries) if (at >= entry.expiresAt) entries.delete(old);
        while (entries.size >= capacity) entries.delete(entries.keys().next().value as string);
      }
      const expiresAt = at + ttlMs;
      entries.set(key, { text: Buffer.from(challenge, "ascii"), issuedAt: at, expiresAt });
      return { challenge, expiresAt };
    },
    take(sessionKey, purpose, challenge) {
      const key = keyOf(sessionKey, purpose);
      if (key === null) return "invalid";
      const entry = entries.get(key);
      // Spent before any check: a second take never finds it.
      entries.delete(key);
      if (entry === undefined || typeof challenge !== "string" || !KEY_PATTERN.test(challenge))
        return "invalid";
      const at = readClock(now);
      if (at === null || at < entry.issuedAt || at >= entry.expiresAt) return "invalid";
      // The text, not its decoded bytes: base64url has two spellings of the same last bits.
      return timingSafeEqual(Buffer.from(challenge, "ascii"), entry.text) ? "ok" : "invalid";
    },
  };
}
