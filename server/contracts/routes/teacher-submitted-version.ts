import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { DocumentKind, WorkKind } from "./shared.ts";
import { WorkId } from "./versions.ts";

// F4-NAS-R20-SRV (Ductus#2059; owner decision 27. 11. 2026): the course teacher's
// read of the revision of a student's work that was submitted for the
// assignment, by its revision number. A new read-only route beside
// work.version.get, which is unchanged and still answers only the owner and the
// active mentor. Who asks comes only from the session; the database decides
// whether the caller teaches the course of the work. Only the revision tied to
// the live submission is returned: any other revision, a work that was not
// submitted or whose submission was withdrawn, another teacher's course, the
// student of the work and a malformed id all read the same 404. The read of the
// text writes a row of the access log (surface submitted_text).

const RevisionText = Type.String({ pattern: "^[1-9][0-9]{0,15}(?![\\s\\S])" });

export const teacherWorkSubmittedVersionGet = defineRoute({
  id: "teacher.work.submitted-version.get",
  method: "GET",
  path: "/api/v1/teacher/works/{documentId}/submitted-versions/{revision}",
  inventory: "app/api/teacher/works/[documentId]/submitted-versions/[revision]/route.ts",
  access: "course_teacher",
  summary:
    "The submitted revision of a student's work, for a teacher of the course of the assignment: the verified canonical text of the revision the student submitted. Only that revision is answered; an earlier or later revision, an unsubmitted or withdrawn work, another course's teacher, the student and an unknown or malformed work id all return 404. A malformed revision returns 422. The read writes a row of the access log.",
  request: {
    params: closed({ documentId: WorkId, revision: RevisionText }),
  },
  responses: [
    {
      status: 200,
      description: "the submitted revision",
      body: closed({
        revision: Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        document: Type.String({
          minLength: 1,
          maxLength: 2_097_152,
          description: "Canonical JSON of the document.",
        }),
        documentKind: Type.Optional(DocumentKind),
        workKind: Type.Optional(WorkKind),
      }),
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const teacherWorkSubmittedVersionRoutes = [teacherWorkSubmittedVersionGet] as const;
