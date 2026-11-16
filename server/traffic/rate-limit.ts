// Rate limit, step 3 of docs/server-map.md §3 (S-1C.3, DAN-814; contract
// Ductus#1836 c.6908215789, attack plan ductura/server#117). One token bucket
// per client IP and one per account (the SHA-256 of the raw session cookie;
// the session is never resolved), each per class of route. A request passes
// only when every bucket it touches has a token, and only then are tokens
// taken: a refused request costs nothing, so a retry after Retry-After passes
// exactly once. The clock is injected. Nothing here throws on input from the
// network, and no IP, cookie or hash ever leaves this file.
import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";

import { clientIpOf } from "./client-ip.ts";

export const RATE_LIMIT_CLASSES = ["login", "enroll", "save", "default"] as const;
export type RateLimitClass = (typeof RATE_LIMIT_CLASSES)[number];

/** Requests per minute; the bucket holds this many and refills it over a minute. */
export type ClassLimits = { readonly perIp: number; readonly perAccount: number | null };
export type RateLimits = { readonly [C in RateLimitClass]: ClassLimits };

/**
 * The defaults of the settings catalogue (contract c.6908215789). Login has no
 * account bucket: there is no session before it.
 */
export const DEFAULT_RATE_LIMITS: RateLimits = Object.freeze({
  login: Object.freeze({ perIp: 30, perAccount: null }),
  enroll: Object.freeze({ perIp: 60, perAccount: 10 }),
  save: Object.freeze({ perIp: 1200, perAccount: 120 }),
  default: Object.freeze({ perIp: 3000, perAccount: 300 }),
});

/** A limit is a whole number of requests per minute in these bounds. */
export const MIN_LIMIT = 1;
export const MAX_LIMIT = 100_000;
/** Buckets kept in all; past it the least recently used goes (N5). */
export const DEFAULT_MAX_BUCKETS = 50_000;

/**
 * The exact paths of a class; any other spelling (a trailing slash, another
 * case, an encoded slash) falls into default, which has a limit too (N11).
 * Enrolment has no route in this repository yet; it gets its path when the
 * route is ported.
 */
const CLASS_ROUTES: ReadonlyMap<string, RateLimitClass> = new Map([
  ["GET /api/v1/auth/login", "login"],
  ["HEAD /api/v1/auth/login", "login"],
  ["GET /api/v1/auth/callback", "login"],
  ["HEAD /api/v1/auth/callback", "login"],
  ["POST /api/v1/evidence/commit", "save"],
]);

export type RateLimitDecision =
  | { readonly allowed: true; readonly limitClass: RateLimitClass }
  | {
      readonly allowed: false;
      readonly limitClass: RateLimitClass;
      readonly bucket: "per_address" | "per_account";
      /** Whole seconds, at least 1, until the refusing bucket has a token. */
      readonly retryAfter: number;
    };

export type RateLimiter = {
  /** Decides and, when allowed, takes one token from every bucket touched. */
  readonly check: (request: IncomingMessage) => RateLimitDecision;
};

/**
 * Units are a token over a minute: a bucket of limit L holds L * 60 000 units,
 * gains L units a millisecond and a request costs 60 000, so whole-millisecond
 * clocks keep the sums exact and Retry-After is never a second short.
 */
type Bucket = { readonly units: number; readonly at: number };
const COST = 60_000;
type Key = {
  readonly kind: "per_address" | "per_account";
  readonly id: string;
  readonly limit: number;
};

const isLimit = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value >= MIN_LIMIT && value <= MAX_LIMIT;

/** null when any limit is outside the bounds; the server then refuses to start (N14). */
export function checkRateLimits(limits: RateLimits): RateLimits | null {
  const out: Partial<Record<RateLimitClass, ClassLimits>> = {};
  for (const name of RATE_LIMIT_CLASSES) {
    const own = Object.hasOwn(limits, name) ? limits[name] : undefined;
    if (typeof own !== "object" || own === null || !isLimit(own.perIp)) return null;
    const perAccount = name === "login" ? null : own.perAccount;
    if (perAccount !== null && !isLimit(perAccount)) return null;
    if (name !== "login" && perAccount === null) return null;
    out[name] = Object.freeze({ perIp: own.perIp, perAccount });
  }
  return Object.freeze(out as RateLimits);
}

/** The class of a request from its method and path, the query left out. */
export function classOf(method: string | undefined, url: string | undefined): RateLimitClass {
  const target = typeof url === "string" ? url : "";
  const query = target.indexOf("?");
  const path = query < 0 ? target : target.slice(0, query);
  return CLASS_ROUTES.get(`${method ?? ""} ${path}`) ?? "default";
}

const hashOf = (value: string): string => createHash("sha256").update(value).digest("base64url");

/**
 * Buckets with a size bound, least recently used first (Map order; a touched
 * bucket moves to the end). Past the bound the least recently used goes; it is
 * almost always full again, and an attacker needs a fresh IP or cookie for
 * every bucket it pushes in, each behind its own IP limit (N5).
 */
function createStore(maxBuckets: number) {
  const buckets = new Map<string, Bucket>();
  return {
    get: (id: string): Bucket | undefined => buckets.get(id),
    set(id: string, bucket: Bucket): void {
      buckets.delete(id);
      while (buckets.size >= maxBuckets) {
        const oldest = buckets.keys().next();
        if (oldest.done === true) break;
        buckets.delete(oldest.value);
      }
      buckets.set(id, bucket);
    },
    touch(id: string): void {
      const bucket = buckets.get(id);
      if (bucket === undefined) return;
      buckets.delete(id);
      buckets.set(id, bucket);
    },
    size: (): number => buckets.size,
  };
}

export type RateLimiterOptions = {
  readonly limits?: RateLimits;
  /** Milliseconds; Date.now unless a test moves the clock. */
  readonly now?: () => number;
  /**
   * The session token of a request, read exactly as server/session reads it
   * (server/http passes sessionTokenFromCookie): a cookie the session takes is
   * the one the account bucket counts, so no second reading of the Cookie
   * header can drop the bucket while the session still works (self-attack
   * on DAN-814 a, B1). Nothing else, null or a throw means no account bucket.
   */
  readonly sessionTokenOf: (request: IncomingMessage) => string | null | undefined;
  readonly maxBuckets?: number;
};

export function createRateLimiter(options: RateLimiterOptions): RateLimiter & {
  /** Buckets held, for the bound test (N5). */
  readonly size: () => number;
} {
  const limits = checkRateLimits(options.limits ?? DEFAULT_RATE_LIMITS);
  if (limits === null) throw new Error("rate limits outside their bounds");
  const maxBuckets = options.maxBuckets ?? DEFAULT_MAX_BUCKETS;
  if (!Number.isInteger(maxBuckets) || maxBuckets < 1) throw new Error("maxBuckets must be >= 1");
  const now = options.now ?? Date.now;
  const store = createStore(maxBuckets);
  const tokenOf = (request: IncomingMessage): string | null => {
    try {
      const token = options.sessionTokenOf(request);
      return typeof token === "string" && token !== "" ? token : null;
    } catch {
      return null;
    }
  };
  // The newest time seen: a clock that goes back never adds tokens (N9).
  let last = -Infinity;

  /** Units a bucket holds at time t. */
  const level = (bucket: Bucket | undefined, limit: number, t: number): number => {
    if (bucket === undefined) return limit * COST;
    const elapsed = Math.max(0, t - bucket.at);
    return Math.min(limit * COST, bucket.units + elapsed * limit);
  };

  return {
    size: () => store.size(),
    check(request) {
      const read = now();
      const t = Number.isFinite(read) ? Math.max(read, last) : last;
      if (Number.isFinite(t)) last = t;
      const at = Number.isFinite(t) ? t : 0;

      const limitClass = classOf(request.method, request.url);
      const own = limits[limitClass];
      const keys: Key[] = [
        {
          kind: "per_address",
          id: `${limitClass} a ${clientIpOf(request) ?? "-"}`,
          limit: own.perIp,
        },
      ];
      if (own.perAccount !== null) {
        const token = tokenOf(request);
        if (token !== null) {
          keys.push({
            kind: "per_account",
            id: `${limitClass} s ${hashOf(token)}`,
            limit: own.perAccount,
          });
        }
      }

      // Decide over every bucket before taking anything (N6).
      const levels = keys.map((key) => level(store.get(key.id), key.limit, at));
      // Retry-After is the longest wait of every short bucket, so a retry
      // after it passes all of them (property test on DAN-814).
      let refusal: { kind: Key["kind"]; waitMs: number } | null = null;
      keys.forEach((key, i) => {
        const have = levels[i] ?? 0;
        if (have >= COST) return;
        const waitMs = (COST - have) / key.limit;
        if (refusal === null || waitMs > refusal.waitMs) refusal = { kind: key.kind, waitMs };
      });
      if (refusal !== null) {
        // A refused bucket stays as it is but counts as used, so a flood of
        // new keys does not push it out ahead of the others (self-attack N2).
        for (const key of keys) store.touch(key.id);
        const { kind, waitMs } = refusal as { kind: Key["kind"]; waitMs: number };
        const retryAfter = Math.min(60, Math.max(1, Math.ceil(waitMs / 1000)));
        return { allowed: false, limitClass, bucket: kind, retryAfter };
      }
      keys.forEach((key, i) => store.set(key.id, { units: (levels[i] ?? 0) - COST, at }));
      return { allowed: true, limitClass };
    },
  };
}
