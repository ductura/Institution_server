import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-NF4-KASNA-POLJE (Ductus#2055, orchestrator decision A): whether a
// submission after the deadline of an assignment is allowed. Allowed by
// default, also for every assignment that existed before. Two routes of their
// own, not a field of institution.course-assignments.post,
// institution.assignment-versions.post or student.notice.get: a new member of
// an existing route is a major release of @ductura/contracts
// (scripts/release/README.md, QA #92). The web sets the field with the PUT
// after it creates the assignment; it may change after publication. Only the
// teacher of the assignment sets it and only a student of its course reads it
// (C-23, from the relation). Enforcement is SRV-NF4-KASNA-PROVEDBA, over the
// same column. Database: institution.set_late_submission_allowed,
// app.my_assignment_late_submission (20261219110000).

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const LateSubmission = closed({ lateSubmissionAllowed: Type.Boolean() });

export const institutionAssignmentLateSubmissionPut = defineRoute({
  id: "institution.assignment-late-submission.put",
  method: "PUT",
  path: "/api/v1/institution/assignments/{assignmentId}/late-submission",
  inventory: "app/api/institution/assignments/[assignmentId]/late-submission/route.ts",
  access: "course_teacher",
  summary:
    "The teacher of the assignment says whether a submission after its deadline is allowed, exactly {lateSubmissionAllowed}; allowed by default. It may change after publication; setting the value in force changes nothing and returns it. A body that is not exactly this is 422. A student, another teacher, an unknown or a malformed assignment returns 404.",
  request: {
    params: closed({ assignmentId: Uuid }),
    contentType: "application/json",
    maxBodyBytes: 256,
    body: LateSubmission,
  },
  responses: [
    {
      status: 200,
      description: "the value in force",
      body: LateSubmission,
      headers: ["cache-control"],
    },
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

export const studentAssignmentLateSubmissionGet = defineRoute({
  id: "student.assignment-late-submission.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/late-submission",
  inventory: "app/api/student/assignments/[assignmentId]/late-submission/route.ts",
  access: "student_enrolled",
  summary:
    "Whether a submission after the deadline of the assignment is allowed, for a student of its course. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [
    {
      status: 200,
      description: "the value in force",
      body: LateSubmission,
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const lateSubmissionRoutes = [
  institutionAssignmentLateSubmissionPut,
  studentAssignmentLateSubmissionGet,
] as const;
