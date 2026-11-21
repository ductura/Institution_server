import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1702 (M6.4, DAN-420; D-21, D-34, D-244; Ductus docs/backend/suradnja.md
// 4.15): the direct-edit setting of a work. Suggestions are the default; the
// student owner alone turns direct edits of the teachers of the work on and
// may revoke them at any time, at once. While they are on, a teacher of the
// work publishes an edit through live.document.put (If-Match with the ETag of
// the state read); every accepted edit is recorded with source teacher. The
// setting and the record are read by both sides through the same functions,
// the same rows for the student and every teacher of the work (PRODUCT §5
// rule 5): no person id, no hash, no text, times in the 5-minute window of
// P-03. Identity, role and institution are never in the body. Read and written
// through collaboration.read_direct_edit, list_direct_edit_record and
// set_direct_edit (server/database/direct-edit).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as live.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const params = closed({ documentId: WorkId });

/** The closed set of 4.15: suggestions (the default) or direct edits. */
const Mode = Type.Union([Type.Literal("suggestions"), Type.Literal("direct")]);
/** An instant in the 5-minute window of P-03, as Date.toISOString writes it, in UTC. */
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});

/** A change of the mode: always the student's. */
const ModeEntry = closed({
  kind: Type.Literal("mode"),
  source: Type.Literal("student"),
  mode: Mode,
  at: Instant,
});
/** An accepted direct edit, marked as the teacher's, with its size in bytes. */
const TeacherEditEntry = closed({
  kind: Type.Literal("teacher_edit"),
  source: Type.Literal("teacher"),
  bytes: Type.Integer({ minimum: 1, maximum: 2 * 1024 * 1024 }),
  at: Instant,
});

const Setting = closed({
  mode: Mode,
  /** null while the mode was never changed. */
  changedAt: Type.Union([Instant, Type.Null()]),
});

export const workDirectEditGet = defineRoute({
  id: "work.direct-edit.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/direct-edit",
  inventory: "app/api/works/[documentId]/direct-edit/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The direct-edit setting of a work and its record, the same for the student of the work and every teacher of its assignment: mode (suggestions, the default, or direct), changedAt (null when never changed) and the record oldest first, at most the last 1000 entries: each change of the mode (source student) and each accepted direct edit (source teacher, its size in bytes). Times are in the 5-minute window of P-03. Another's, an unknown or a malformed work returns 404.",
  request: { params },
  responses: [
    {
      status: 200,
      description: "the setting and its record",
      body: closed({
        ...Setting.properties,
        record: Type.Array(Type.Union([ModeEntry, TeacherEditEntry]), { maxItems: 1000 }),
      }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const workDirectEditPut = defineRoute({
  id: "work.direct-edit.put",
  method: "PUT",
  path: "/api/v1/works/{documentId}/direct-edit",
  inventory: "app/api/works/[documentId]/direct-edit/route.ts",
  access: "student_owner",
  summary:
    'The student owner sets the direct-edit mode of the work: {mode: "direct"} turns direct edits of its teachers on, {mode: "suggestions"} revokes them at once and without the other side. Sent as application/json, at most 1 KiB. The value is absolute: the same mode again answers unchanged and writes nothing. 200 {outcome, mode, changedAt}. While the mode is direct, a teacher of the work publishes an edit with live.document.put and `If-Match: \"<etag>\"`, the ETag of the state read (64 hex): the edit replaces exactly that state and is recorded as the teacher\'s; a teacher\'s 409 always carries a null token, and with suggestions the teacher\'s put is 404. A teacher, another\'s, an unknown, a malformed or a submitted work returns 404; another mode is 422.',
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: closed({ mode: Mode }),
  },
  responses: [
    {
      status: 200,
      description: "applied, or the same mode again",
      body: closed({
        outcome: Type.Union([Type.Literal("applied"), Type.Literal("unchanged")]),
        ...Setting.properties,
      }),
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

export const directEditRoutes = [workDirectEditGet, workDirectEditPut] as const;
