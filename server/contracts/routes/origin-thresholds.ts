import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkId } from "./collaboration.ts";
import { ORIGIN_KINDS } from "./origin-composition.ts";
import { MUTATION_GUARD } from "./shared.ts";

// SRV-1111 (Ductus#2052; P-1, rule 12): the thresholds of a faculty per kind of
// origin, and the comparison of a work with them. Database: 20261213100400
// (institution.origin_threshold, app.origin_thresholds_read,
// app.origin_thresholds_put, app.work_origin_threshold_status).
//
// There are NO default thresholds: a faculty that has written nothing has an
// empty list and nothing is compared. The comparison is a statement of
// conformity with the rules of the faculty ("u skladu / za pregled /
// prekoračeno"), never an assessment of a student: it answers one of three
// closed words per kind that has a threshold, no share, no number, no ranking.
// It blocks nothing. The student sees the same answer as the teacher.

const Kind = Type.Union(ORIGIN_KINDS.map((kind) => Type.Literal(kind)));
const Strictness = Type.Union([Type.Literal("hard"), Type.Literal("soft")]);

/** One threshold: the kind, the share in percent (0 to 100) and how strictly it holds. */
const Threshold = closed({
  origin: Kind,
  thresholdPercent: Type.Number({ minimum: 0, maximum: 100 }),
  strictness: Strictness,
});

export const originThresholdsGet = defineRoute({
  id: "institution.origin-thresholds.get",
  method: "GET",
  path: "/api/v1/institution/origin-thresholds",
  inventory: "app/api/institution/origin-thresholds/route.ts",
  access: "institution_admin",
  summary:
    "The thresholds of the caller's institution per kind of origin, for an administrator of it: at most one per kind of the closed list, in the order of the list, an empty list while the faculty has written none (there are no defaults). No query: any query parameter is 422. A teacher, a student and an account without a confirmed administrator role are 403.",
  request: { query: Type.Object({}, { maxProperties: 0 }) },
  responses: [
    {
      status: 200,
      description: "the thresholds written so far",
      body: closed({ thresholds: Type.Array(Threshold, { maxItems: 6 }) }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

const OriginParam = closed({ origin: Kind });

export const originThresholdPut = defineRoute({
  id: "institution.origin-threshold.put",
  method: "PUT",
  path: "/api/v1/institution/origin-thresholds/{origin}",
  inventory: "app/api/institution/origin-thresholds/[origin]/route.ts",
  access: "institution_admin",
  summary:
    "An administrator of the institution sets the threshold of one kind of origin: exactly {thresholdPercent, strictness}, at most 1 KiB, sent as application/json. The kind comes from the path and is one of the closed list; the threshold is a whole percent, 0 to 100, and strictness is hard or soft. changed is false when the kind already held exactly this and nothing is recorded. A kind outside the list, a value outside these or a malformed body is 422. A teacher, a student and an account without a confirmed administrator role are 403. The institution, the author and the time come from the session and the database clock. The change is recorded in the audit trail in the same transaction. Success follows the database commit.",
  request: {
    params: OriginParam,
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({
      thresholdPercent: Type.Integer({ minimum: 0, maximum: 100 }),
      strictness: Strictness,
    }),
  },
  responses: [
    {
      status: 200,
      description: "the threshold is set",
      body: closed({ changed: Type.Boolean() }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const originThresholdDelete = defineRoute({
  id: "institution.origin-threshold.delete",
  method: "DELETE",
  path: "/api/v1/institution/origin-thresholds/{origin}",
  inventory: "app/api/institution/origin-thresholds/[origin]/route.ts",
  access: "institution_admin",
  summary:
    "An administrator of the institution removes the threshold of one kind of origin; the kind has none from then on and nothing is compared for it. 204 also when the kind had none (nothing is recorded then). No body. A kind outside the closed list is 422. A teacher, a student and an account without a confirmed administrator role are 403. The removal is recorded in the audit trail in the same transaction.",
  request: { params: OriginParam },
  responses: [{ status: 204, description: "the kind has no threshold" }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const workOriginThresholdsGet = defineRoute({
  id: "work.origin-thresholds.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/origin-thresholds",
  inventory: "app/api/works/[documentId]/origin-thresholds/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The comparison of a work with the thresholds of its faculty: one entry per kind that HAS a threshold, in the order of the closed list, each in_line (the share is at or below the threshold), for_review (above a soft threshold) or exceeded (above a hard threshold). An empty list while the faculty has no thresholds. It holds no share and no number; it is a statement of conformity with the rules of the faculty, not an assessment of the student, and it blocks nothing. The same answer for the student who owns the work and for its readers. Another's, an unknown or a malformed work returns 404.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the state per kind that has a threshold",
      body: closed({
        comparison: Type.Array(
          closed({
            origin: Kind,
            state: Type.Union([
              Type.Literal("in_line"),
              Type.Literal("for_review"),
              Type.Literal("exceeded"),
            ]),
          }),
          { maxItems: 6 },
        ),
      }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const originThresholdsRoutes = [
  originThresholdsGet,
  originThresholdPut,
  originThresholdDelete,
  workOriginThresholdsGet,
] as const;
