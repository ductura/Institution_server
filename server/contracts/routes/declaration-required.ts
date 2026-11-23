import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 OD-6,
// OD-15, section 6.7): whether a submission of an assignment requires a
// declaration confirmed for the submitted revision. Off by default (OD-6);
// for the pilot the teacher of the assignment turns it on here. Only the
// teacher of the assignment reads and sets it (C-23, from the relation); the
// student reads it as declarationRequired in student.declaration.get. Every
// change is recorded with its author and time and never changed
// (audit.declaration_required_event). Database:
// institution.declaration_required_setting, institution.set_declaration_required
// (20261214110000).

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const AssignmentParams = closed({ assignmentId: Uuid });

const Setting = closed({
  required: Type.Boolean(),
  /** Null: never changed, off by default. */
  changedAt: Type.Union([Instant, Type.Null()]),
});
const INVENTORY = "app/api/teacher/assignments/[assignmentId]/declaration-required/route.ts";
const PATH = "/api/v1/teacher/assignments/{assignmentId}/declaration-required";

export const teacherDeclarationRequiredGet = defineRoute({
  id: "teacher.declaration-required.get",
  method: "GET",
  path: PATH,
  inventory: INVENTORY,
  access: "course_teacher",
  summary:
    "Whether a submission of the assignment requires a declaration confirmed for the submitted revision (off by default), and when it was last changed, for the teacher of the assignment. A student, another teacher, an unknown or a malformed assignment returns 404.",
  request: { params: AssignmentParams },
  responses: [
    { status: 200, description: "the switch", body: Setting, headers: ["cache-control"] },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherDeclarationRequiredPut = defineRoute({
  id: "teacher.declaration-required.put",
  method: "PUT",
  path: PATH,
  inventory: INVENTORY,
  access: "course_teacher",
  summary:
    "The teacher of the assignment turns the required declaration on or off, exactly {required}. While it is on, a submission without a declaration confirmed for the submitted revision is refused (submission.submit-second.post 409 declaration_required). Every change is recorded with its author and time in the same transaction; setting the value in force changes nothing and returns it. A submission already recorded stays. A body that is not exactly this is 422. A student, another teacher, an unknown or a malformed assignment returns 404.",
  request: {
    params: AssignmentParams,
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({ required: Type.Boolean() }),
  },
  responses: [
    { status: 200, description: "the switch in force", body: Setting, headers: ["cache-control"] },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const declarationRequiredRoutes = [
  teacherDeclarationRequiredGet,
  teacherDeclarationRequiredPut,
] as const;
