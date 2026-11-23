import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// PIL-K-IZJAVA-SRV (owner decision of 23. 11. 2026; declaration-v1 §6.7, OD-6):
// whether a submission of an assignment requires a declaration confirmed for
// the submitted revision. Off by default; for the pilot the teacher turns it
// on. Only the teacher of the assignment reads and sets it (C-23); every
// change is written with its author and time to an append-only trail in the
// same transaction. The student reads it as declarationRequired of
// student.declaration.get. Database: institution.declaration_requirement and
// institution.set_declaration_required (20261214110000).

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
/** The switch and when it was last changed; changedAt is null while the default holds. */
const RequirementState = closed({
  required: Type.Boolean(),
  changedAt: Type.Union([Instant, Type.Null()]),
});
const AssignmentParams = closed({ assignmentId: Uuid });
const INVENTORY = "app/api/teacher/assignments/[assignmentId]/declaration-requirement/route.ts";

export const teacherDeclarationRequirementGet = defineRoute({
  id: "teacher.declaration-requirement.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/declaration-requirement",
  inventory: INVENTORY,
  access: "course_teacher",
  summary:
    "The teacher of the assignment reads whether a submission requires a declaration confirmed for the submitted revision, off by default, and when it was last changed (null while the default holds). A student, another teacher, an administrator, an unknown or a malformed assignment returns 404.",
  request: { params: AssignmentParams },
  responses: [{ status: 200, description: "the declaration requirement", body: RequirementState }],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const teacherDeclarationRequirementPut = defineRoute({
  id: "teacher.declaration-requirement.put",
  method: "PUT",
  path: "/api/v1/teacher/assignments/{assignmentId}/declaration-requirement",
  inventory: INVENTORY,
  access: "course_teacher",
  summary:
    "Only the teacher of the assignment sets whether a submission requires a declaration confirmed for the submitted revision, exactly {required}. A submission requested before the change is recorded as requested; one requested after it follows the new value. Setting the value in force changes nothing. Every change is written with its author and time to an append-only trail in the same transaction. Answers 200 with the new state. A body that is not exactly this is 422. A student, another teacher, an administrator, an unknown or a malformed assignment returns 404.",
  request: {
    params: AssignmentParams,
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ required: Type.Boolean() }),
  },
  responses: [
    { status: 200, description: "the new declaration requirement", body: RequirementState },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(503, "unavailable"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
  ],
});

export const declarationRequirementRoutes = [
  teacherDeclarationRequirementGet,
  teacherDeclarationRequirementPut,
] as const;
