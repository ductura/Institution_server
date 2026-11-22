import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

// SRV-1606 (Ductus#2052, WEB-2155, WEB-2121): the teacher returns the WHOLE submitted
// work to the student for revision (prototype dialog dd-h, ReturnForRevisionDialog:
// a comment and a new revision due date). Not a milestone and not a comment anchored
// in the text. The submission is no longer the live one: the student edits and
// submits again as the next round (attempt) of the history of submissions. Database:
// evidence.submission_return and app.return_work_for_revision (20261213100600).

const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
/** A date and time with an offset, as the revision due date of a milestone. */
const AnyInstant = Type.String({
  pattern: `^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)${END}`,
});
/** Date.toISOString of a finite instant. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});

/** The comment and the new revision due date, as the dialog sends them. */
export const ReturnForRevisionInput = closed({
  comment: Type.String({ minLength: 1, maxLength: 2000 }),
  /** A reminder: it never blocks writing or submitting. */
  revisionDueAt: Type.Optional(AnyInstant),
});

export const ReturnForRevisionResult = closed({
  id: Uuid,
  /** The state of the work: the submission is returned and the student revises it. */
  state: Type.Literal("returned_for_revision"),
  /** The round (attempt) of the submission that was returned, from 1. */
  round: Type.Integer({ minimum: 1, maximum: 1000 }),
  comment: Type.String({ minLength: 1, maxLength: 2000 }),
  revisionDueAt: Type.Union([Instant, Type.Null()]),
  returnedAt: Instant,
});

export const workReturnForRevisionPost = defineRoute({
  id: "work.return-for-revision.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/return-for-revision",
  inventory: "app/api/works/[documentId]/return-for-revision/route.ts",
  access: "course_teacher",
  summary:
    "The teacher of the work's assignment (its course teacher or its mentor) returns the whole submitted work to the student for revision, with a required comment and an optional new revision due date (a reminder, it never blocks). The submission stays recorded but is no longer the live one: the student edits and submits again as the next round. Only a live submission can be returned (409 otherwise). The student owner gets 403; everybody else who is not its teacher, and an unknown work, 404.",
  request: {
    params: closed({ documentId: DocumentId }),
    contentType: "application/json",
    body: ReturnForRevisionInput,
    maxBodyBytes: 8192,
  },
  responses: [
    {
      status: 200,
      description: "The return, written once",
      body: ReturnForRevisionResult,
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(403, "forbidden"),
    error(409, "conflict"),
    error(400, "invalid_json"),
    error(415, "unsupported_media_type"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const returnForRevisionRoutes = [workReturnForRevisionPost] as const;
