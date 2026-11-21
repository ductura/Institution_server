import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1306 (plan M10.3): the HTTP layer over the legal holds of SRV-1305
// (app.legal_holds, app.place_legal_hold, app.release_legal_hold; migration
// 20261209110000). Only a confirmed administrator of the institution may call
// the three routes; the administrator who placed a hold can never release it,
// so a second administrator does (403 for the first). Who may do what is the
// decision of the database; the caller comes only from the session.

/** Lowercase UUID, as PostgreSQL writes uuid. */
const HoldId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** Any-case UUID of the path; the handler lower-cases it. */
const HoldIdParam = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const SubjectType = Type.Union([
  Type.Literal("work"),
  Type.Literal("student"),
  Type.Literal("assignment"),
]);
const SubjectId = Type.String({ minLength: 1, maxLength: 256 });
/** legal_holds.case_reference: 1 to 120 characters. */
const CaseReference = Type.String({ minLength: 1, maxLength: 120 });

const Hold = closed({
  holdId: HoldId,
  subjectType: SubjectType,
  subjectId: SubjectId,
  caseReference: CaseReference,
  placedBy: Type.String({ minLength: 1 }),
  placedAt: Instant,
  /** Null while the hold stands. */
  releasedBy: Type.Union([Type.String({ minLength: 1 }), Type.Null()]),
  releasedAt: Type.Union([Instant, Type.Null()]),
});

export const legalHoldsGet = defineRoute({
  id: "institution.legal-holds.get",
  method: "GET",
  path: "/api/v1/institution/legal-holds",
  inventory: "app/api/institution/legal-holds/route.ts",
  access: "institution_admin",
  summary:
    "The legal holds of the caller's institution, standing and released, for a confirmed administrator. A caller who is not an administrator is 403.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the holds, possibly none",
      body: closed({ holds: Type.Array(Hold) }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
});

export const legalHoldsPost = defineRoute({
  id: "institution.legal-holds.post",
  method: "POST",
  path: "/api/v1/institution/legal-holds",
  inventory: "app/api/institution/legal-holds/route.ts",
  access: "institution_admin",
  summary:
    "An administrator places a legal hold on a work, a student or an assignment of the institution: exactly {subjectType, subjectId, caseReference}, at most 2 KiB, sent as application/json. A caller who is not an administrator is 403; a subject outside the institution is 404; an invalid reference is 422.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 2048,
    body: closed({
      subjectType: SubjectType,
      subjectId: SubjectId,
      caseReference: CaseReference,
    }),
  },
  responses: [
    {
      status: 201,
      description: "the hold is placed",
      body: closed({ holdId: HoldId }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const legalHoldReleasePost = defineRoute({
  id: "institution.legal-hold-release.post",
  method: "POST",
  path: "/api/v1/institution/legal-holds/{holdId}/release",
  inventory: "app/api/institution/legal-holds/[holdId]/release/route.ts",
  access: "institution_admin",
  summary:
    "A second administrator releases a legal hold with a reason: exactly {reason}, 1 to 600 characters, at most 2 KiB, sent as application/json. The administrator who placed the hold, and a caller who is not an administrator, get 403. A missing hold or one of another institution is 404; a hold already released is 409; a malformed id or reason is 422 (an id that is not a UUID is 404).",
  request: {
    params: closed({ holdId: HoldIdParam }),
    contentType: "application/json",
    maxBodyBytes: 2048,
    body: closed({ reason: Type.String({ minLength: 1, maxLength: 600 }) }),
  },
  responses: [
    {
      status: 200,
      description: "the hold is released",
      body: closed({ holdId: HoldId, releasedAt: Instant }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const legalHoldRoutes = [legalHoldsGet, legalHoldsPost, legalHoldReleasePost] as const;
