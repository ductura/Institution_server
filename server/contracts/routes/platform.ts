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
      description: "alive",
      body: closed({
        status: Type.Literal("ok"),
        // The API version (API_VERSION) for the preloader; optional until S-1M-a sends it.
        version: Type.Optional(
          Type.String({
            pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$",
            description: "API version, major.minor.patch",
          }),
        ),
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

/** Answers every route may give besides its own errors. */
export const SHARED_ERRORS = [INTERNAL.error] as const;

export const platformRoutes = [health, ready, status] as const;
