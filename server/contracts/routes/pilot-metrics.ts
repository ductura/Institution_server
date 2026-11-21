import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

/** The smallest group a published count may describe (plan P-D6). */
export const PILOT_METRICS_MIN_GROUP = 5;

// A count is 0, a multiple of five from five up (rounded down), or null when
// hidden. The schema itself refuses 1 to 4, so no answer carries a small group.
const Count = Type.Union([
  Type.Literal(0),
  Type.Integer({
    minimum: PILOT_METRICS_MIN_GROUP,
    maximum: 2_147_483_645,
    multipleOf: PILOT_METRICS_MIN_GROUP,
  }),
  Type.Null(),
]);
const Duration = Type.Union([Type.Integer({ minimum: 0, maximum: 2_147_483_647 }), Type.Null()]);

export const PilotMetrics = closed({
  asOf: Type.String({ format: "date-time", maxLength: 24 }),
  minimumGroup: Type.Literal(PILOT_METRICS_MIN_GROUP),
  submissions: closed({ recorded: Count, notRecorded: Count }),
  receipts: closed({ issued: Count, pending: Count }),
  helpRequests: closed({ total: Count, saveProblems: Count }),
  receiptTime: closed({ p50Ms: Duration, p95Ms: Duration }),
});
export type PilotMetrics = Static<typeof PilotMetrics>;

export const pilotMetricsGet = defineRoute({
  id: "ops.pilot-metrics.get",
  method: "GET",
  path: "/api/v1/ops/pilot-metrics",
  inventory: "app/api/ops/pilot-metrics/route.ts",
  access: "operator",
  summary:
    "Whole-server technical numbers of the pilot for an operator (plan P-D6): recorded submissions and requests without one, signed receipts and submissions still without one, help requests and those reporting a save problem, and the median and 95th percentile from a submission request to its signed receipt. Counted up to asOf, the start of the current day in Zagreb. No identifier, no text, no breakdown and no filter. A count from 1 to 4 is null, and so is any count derivable from the published ones by subtraction; a shown count is rounded down to a multiple of five. The durations are null below five receipts and whenever the receipt counts are hidden, and capped at 2147483647 ms.",
  request: { query: Type.Object({}, { maxProperties: 0 }) },
  responses: [{ status: 200, description: "the pilot numbers", body: PilotMetrics }],
  errors: [
    error(401, "unauthenticated"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});
