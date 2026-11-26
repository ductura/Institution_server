import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { END } from "./teacher.ts";

// F4-NAS-R16-SRV (NAS-R16, NAS-46): the revision due date of a work, read back.
// The teacher writes it in work.return-for-revision.post; this additive route reads
// it for the student owner and for a teacher of the work. Database:
// app.read_work_revision_due (20261220340000). Existing routes do not change.

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

export const workRevisionDueGet = defineRoute({
  id: "work.revision-due.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/revision-due",
  inventory: "app/api/works/[documentId]/revision-due/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The revision due date of the open return of a work: the round that the teacher returned for revision and the due date set then (null when none was set), while the student has not submitted again. When the work is not returned, or was submitted again, returned is null. The comment of the return is not part of the answer. The student who owns the work and a teacher of its assignment read it; everybody else, a work that was never submitted, an unknown work and a malformed id read the same 404. The read writes nothing.",
  request: { params: closed({ documentId: DocumentId }) },
  responses: [
    {
      status: 200,
      description: "the open return, or null",
      body: closed({
        returned: Type.Union([
          closed({
            round: Type.Integer({ minimum: 1, maximum: 1000 }),
            revisionDueAt: Type.Union([Instant, Type.Null()]),
            returnedAt: Instant,
          }),
          Type.Null(),
        ]),
      }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const workRevisionDueRoutes = [workRevisionDueGet] as const;
