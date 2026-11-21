import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-1403 (M1.3, DAN-304, D-205 t. 4; Ductus#2052 c.7062876936): the
// signed-in person's own staff affiliation, the fact an administrator may
// confirm a teacher role on. It is read from identity.staff_affiliation
// through identity.my_staff_affiliation(), which names nobody: who it is comes
// from the session alone. Without an affiliation the person stays a student
// and reads the closed code staff_affiliation_missing; an affiliation of
// another institution was never recorded, so it reads the same.

/** The attribute that released the staff value; never the value or its scope. */
export const STAFF_AFFILIATION_SOURCES = [
  "hrEduPersonAffiliation",
  "eduPersonAffiliation",
  "eduPersonScopedAffiliation",
] as const;

/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

const Confirmed = closed({
  confirmed: Type.Literal(true),
  source: Type.Union(STAFF_AFFILIATION_SOURCES.map((source) => Type.Literal(source))),
  /** When a login last confirmed the affiliation. */
  confirmedAt: Instant,
});
const Missing = closed({
  confirmed: Type.Literal(false),
  code: Type.Literal("staff_affiliation_missing"),
});

export const staffAffiliationGet = defineRoute({
  id: "profile.staff-affiliation.get",
  method: "GET",
  path: "/api/v1/me/staff-affiliation",
  inventory: "app/api/me/staff-affiliation/route.ts",
  access: "signed_in",
  summary:
    "The caller's own staff affiliation: its source and when a login last confirmed it, or the closed code staff_affiliation_missing. Without one the person stays a student and no teacher role can be confirmed; another institution's affiliation is never recorded.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the affiliation, or the closed code without one",
      body: Type.Union([Confirmed, Missing]),
    },
  ],
  errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
});

export const staffAffiliationRoutes = [staffAffiliationGet] as const;
