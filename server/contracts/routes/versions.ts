import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-9A (Ductus#2028, wave 9 "Zapis procesa"): the versions of one work, for
// its owner and the teacher of its assignment, the same list for both
// (Ductus docs/PRODUCT.md §5 rules 5 and 7; N-11 in Ductus
// docs/design/ductura/m7-reference-b). A version is a saved point of the
// document (checkpoint) or the submission. The list names no text, hash,
// submission id or exact time: a revision and a whole minute (D-24), and for
// the submission whether it came after the deadline; no size of change, no
// mark, no colour. The checkpoints end at the submitted revision, as in the
// replay. Read through app.read_work_versions (server/database/work-versions);
// a teacher's read writes the access log.

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as live.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)(?![\\s\\S])`,
});
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** A whole UTC minute (D-24). */
const Minute = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z$" });

/** The most versions in one page (WORK_VERSIONS_PAGE_SIZE of the database port). */
const PAGE_SIZE = 200;

const Checkpoint = closed({
  kind: Type.Literal("checkpoint"),
  revision: Revision,
  savedMinute: Minute,
});
const Submission = closed({
  kind: Type.Literal("submission"),
  revision: Revision,
  /** The minute the student asked to submit. */
  savedMinute: Minute,
  afterDeadline: Type.Boolean(),
});

export const workVersionsGet = defineRoute({
  id: "work.versions.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/versions",
  inventory: "app/api/works/[documentId]/versions/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "One page of the versions of a work, newest first (revision descending, the submission before the checkpoint of its revision), at most 200: the saved points of the document up to the submitted revision and the submission. The same list for the owner and the teacher of the assignment; a teacher's read writes the access log. beforeRevision, from nextBeforeRevision of the previous page, asks for the versions below that revision; a revision is never split across two pages. Another's, an unknown or a malformed work returns 404.",
  request: {
    params: closed({ documentId: WorkId }),
    query: closed({
      beforeRevision: Type.Optional(Type.String({ pattern: "^[1-9][0-9]{0,15}$" })),
    }),
  },
  responses: [
    {
      status: 200,
      description: "one page of versions, possibly empty",
      body: closed({
        versions: Type.Array(Type.Union([Submission, Checkpoint]), {
          maxItems: PAGE_SIZE,
        }),
        /** The beforeRevision of the next page, or null on the last one. */
        nextBeforeRevision: Type.Union([
          Type.Integer({ minimum: 2, maximum: Number.MAX_SAFE_INTEGER }),
          Type.Null(),
        ]),
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

export const versionsRoutes = [workVersionsGet] as const;
