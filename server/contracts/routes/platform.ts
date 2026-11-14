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
  responses: [{ status: 200, description: "alive", body: closed({ status: Type.Literal("ok") }) }],
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

export const platformRoutes = [health, ready, status] as const;
