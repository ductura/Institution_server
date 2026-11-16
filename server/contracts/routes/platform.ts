import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

const CapabilityStatus = Type.Union([
  Type.Literal("ok"),
  Type.Literal("nedostupno"),
  Type.Literal("nije_konfigurirano"),
]);
// Only checked capabilities are reported; a missing one was not checked.
const Capabilities = closed({
  database: Type.Optional(CapabilityStatus),
  storage: Type.Optional(CapabilityStatus),
  signing: Type.Optional(CapabilityStatus),
  queue: Type.Optional(CapabilityStatus),
});
const SemVer = (description: string) =>
  Type.String({ pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$", description });
const ComponentState = Type.Union([
  Type.Literal("radi"),
  Type.Literal("ne_radi"),
  Type.Literal("nije_ukljuceno"),
]);

export const health = defineRoute({
  id: "platform.health.get",
  method: "GET",
  path: "/api/v1/health",
  inventory: "app/api/health/route.ts",
  access: "anyone",
  summary: "Liveness: the process answers. Reads no database, session or environment.",
  request: {},
  responses: [
    {
      status: 200,
      // The summary above is the 1.2.0 text; a new summary breaks the guard (U5), so
      // the answer as it is since 1.3.0 (S-1M-a, DAN-795) is described here.
      description:
        "alive. Since 1.3.0 also the state of the main database (`state`, checked with a time limit) and the versions; never an address, a name or an error.",
      body: closed({
        // The process answers; `state` says whether the main database does.
        status: Type.Literal("ok"),
        // Deprecated: never sent since 1.3.0 (apiVersion has it); kept, as removing it breaks v1.
        version: Type.Optional(SemVer("API version, major.minor.patch")),
        // Optional in the schema only so that 1.2.0 answers stay valid; the server always sends them.
        state: Type.Optional(
          Type.Union([Type.Literal("ok"), Type.Literal("degraded")], {
            description: "degraded: the main database is not ok or did not answer in time",
          }),
        ),
        apiVersion: Type.Optional(SemVer("API version (API_VERSION)")),
        serverVersion: Type.Optional(SemVer("version of the server build")),
        minClientVersion: Type.Optional(SemVer("oldest client version this server serves")),
      }),
    },
  ],
  errors: [],
});

export const ready = defineRoute({
  id: "platform.ready.get",
  method: "GET",
  path: "/api/v1/ready",
  inventory: "app/api/ready/route.ts",
  access: "anyone",
  summary: "Readiness per capability, closed words only.",
  request: {},
  responses: [
    {
      status: 200,
      description: "ready",
      body: closed({ status: Type.Literal("ready"), capabilities: Capabilities }),
    },
  ],
  errors: [
    // Two errors of one status (a oneOf): v1 keeps both bodies as they are.
    error(
      503,
      "unavailable",
      closed({ status: Type.Literal("unavailable"), capabilities: Capabilities }),
    ),
    error(503, "draining", closed({ status: Type.Literal("draining") })),
  ],
});

export const status = defineRoute({
  id: "platform.status.get",
  method: "GET",
  path: "/api/v1/status",
  inventory: "app/api/status/route.ts",
  access: "anyone",
  summary: "Public status in three parts, closed words, nothing about a person.",
  request: {},
  responses: [
    {
      status: 200,
      description: "status",
      body: closed({
        checkedAt: Type.String({ format: "date-time", maxLength: 24 }),
        components: closed({
          writing: ComponentState,
          submission: ComponentState,
          mentorView: ComponentState,
        }),
      }),
    },
  ],
  errors: [error(503, "unavailable", "none")],
});

/** The answer to every /api/v1 path no route handles, for any method (app/api/[...path]). */
export const FALLBACK = {
  inventory: "app/api/[...path]/route.ts",
  error: error(404, "not_found"),
} as const;

/** The answer to a known path with a method it has no route for; `allow` names those. */
export const METHOD_NOT_ALLOWED = {
  error: error(405, "method_not_allowed"),
} as const;

/**
 * The answer of any route whose handler fails before the first byte of its
 * answer (DAN-776). Only the problem body of `internal` (S-1L.3): never the
 * message, name or stack of the error, SQL or anything else from inside the
 * server but the request id.
 */
export const INTERNAL = {
  error: error(500, "internal"),
} as const;

/**
 * The answer of the rate limit, step 4 of the pipeline, before any route
 * (S-1C.3, DAN-814; contract Ductus#1836 c.6908215789): the problem body of
 * `too_many_requests` with Retry-After in whole seconds. A route's own 429
 * codes (server/http/error-catalog.ts, ROUTE_429_CODES) stay apart.
 */
export const TOO_MANY_REQUESTS = {
  error: error(429, "too_many_requests"),
  headers: ["retry-after"],
} as const;

/**
 * Answers every route may give besides its own errors. A new status on an
 * existing route breaks v1 (breaking.ts), so openapi/v1.json publishes them
 * once, in info["x-shared-errors"], not under each route (review on DAN-814 b).
 */
export const SHARED_ERRORS = [INTERNAL.error, TOO_MANY_REQUESTS.error] as const;

/** Headers a shared error carries, by "status code" (Retry-After on the 429). */
export const SHARED_ERROR_HEADERS: Readonly<Record<string, readonly string[]>> = {
  "429 too_many_requests": TOO_MANY_REQUESTS.headers,
};

export const platformRoutes = [health, ready, status] as const;
