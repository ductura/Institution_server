import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// F4-PM2-R01 (Ductus#2059, owner decision of 26. 11. 2026): additive. The
// submission route stays synchronous and its contract is unchanged; after a
// submission is recorded the worker reconstructs the submitted revision once
// more and keeps a verdict, which the student reads here. `pending` until the
// worker has kept one, `verified` when the reconstruction gave the recorded
// hash, `mismatch` when it did not. Only the student who submitted reads it;
// anyone else, an unknown assignment and one without a submission read 404.
// Database: app.my_submission_reconstruction (20261220400000).
export const studentAssignmentSubmissionReconstructionGet = defineRoute({
  id: "student.assignment-submission-reconstruction.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/submission-reconstruction",
  inventory: "app/api/student/assignments/[assignmentId]/submission-reconstruction/route.ts",
  access: "student_enrolled",
  summary:
    "The state of the reconstruction the worker makes after the student's own submission of the assignment: pending, verified or mismatch. The submission itself is unchanged. Another student's, an unknown, a malformed assignment id and an assignment without a submission return 404.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [
    {
      status: 200,
      description: "the state of the reconstruction",
      body: closed({
        state: Type.Union([
          Type.Literal("pending"),
          Type.Literal("verified"),
          Type.Literal("mismatch"),
        ]),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const submissionReconstructionRoutes = [
  studentAssignmentSubmissionReconstructionGet,
] as const;
