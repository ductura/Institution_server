import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkId } from "./collaboration.ts";
import { MUTATION_GUARD } from "./shared.ts";

// PIL-P1-RITAM-SRV (Ductus#2052; P-1 rule 4, Ustav v1.7/v1.8): the rhythm of
// typing over HTTP. A burst is the gaps in milliseconds between inputs inside
// it, at most 130 per burst, and nothing else: no key, no content, and no
// measure derived from the gaps (no speed, no average, no profile, no
// comparison). The student who owns the work records bursts and deletes what
// was recorded; the owner and the readers of the work read the bursts and the
// state of the switch. The switch is the teacher's, per assignment (Daniel
// 22. 11. 2026.): only the teacher of the assignment's course, or its mentor,
// switches it off or on; while it is off nothing is recorded and nothing is
// read. It is a record of input, not of authorship. Database:
// app.input_rhythm_record, _read, _delete (20261213100300) and
// app.input_rhythm_switch, _switch_read, _state (20261213110100).

/** The most gaps of one burst; the client splits or thins a longer one. */
export const RHYTHM_MAX_GAPS = 130;
/** The longest gap the database accepts, one hour in milliseconds. */
export const RHYTHM_MAX_GAP_MS = 3_600_000;

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });
/** A whole number of milliseconds, 0 to one hour; the database checks the same bounds (422). */
const Gap = Type.Integer({
  minimum: 0,
  maximum: RHYTHM_MAX_GAP_MS,
  description: "a gap in milliseconds, 0 to 3600000",
});
const Gaps = Type.Array(Gap, {
  minItems: 1,
  maxItems: RHYTHM_MAX_GAPS,
});
const Burst = closed({ id: Uuid, gapsMs: Gaps, recordedAt: Instant });
const Switch = closed({ enabled: Type.Boolean() });
/**
 * The state of the teacher's switch, as the student and the teacher read it:
 * who changed it last (the role in the assignment and the name, null when no
 * name is known) and when; both null while the default holds.
 */
const SwitchState = closed({
  enabled: Type.Boolean(),
  changedBy: Type.Union([
    closed({
      role: Type.Union([Type.Literal("teacher"), Type.Literal("mentor")]),
      name: Type.Union([Type.String({ minLength: 1, maxLength: 511 }), Type.Null()]),
    }),
    Type.Null(),
  ]),
  changedAt: Type.Union([Instant, Type.Null()]),
});

const WorkParams = closed({ documentId: WorkId });
const AssignmentParams = closed({ assignmentId: Uuid });
const WORK_INVENTORY = "app/api/works/[documentId]/input-rhythm/route.ts";
const TEACHER_INVENTORY = "app/api/teacher/assignments/[assignmentId]/input-rhythm/route.ts";
const READ_ERRORS = [
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(503, "unavailable"),
];
const WRITE_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(503, "unavailable"),
];
const BODY_ERRORS = [
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
];

export const inputRhythmPost = defineRoute({
  id: "work.input-rhythm.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/input-rhythm",
  inventory: WORK_INVENTORY,
  access: "student_owner",
  summary:
    "The student who owns the work records one burst, exactly {gapsMs}: 1 to 130 whole gaps in milliseconds (0 to 3600000) between inputs, never a key or a content. Answers 200 {recorded: true}, or {recorded: false} while the teacher has switched the recording off: then nothing is saved. A body that is not exactly this is 422. Anyone but the owner of the work gets 404.",
  request: {
    params: WorkParams,
    contentType: "application/json",
    maxBodyBytes: 4 * 1024,
    body: closed({ gapsMs: Gaps }),
  },
  responses: [
    {
      status: 200,
      description: "whether the burst was saved",
      body: closed({ recorded: Type.Boolean() }),
    },
  ],
  errors: [...WRITE_ERRORS, ...BODY_ERRORS],
});

export const inputRhythmGet = defineRoute({
  id: "work.input-rhythm.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/input-rhythm",
  inventory: WORK_INVENTORY,
  access: "owner_or_course_teacher",
  summary:
    "The recorded bursts of a work, oldest first: the gaps in milliseconds and the time of each, nothing derived from them. The same answer for the student who owns the work and for its readers. None while the teacher has switched the recording off. It is a record of input, not of authorship. Another's, an unknown or a malformed work returns 404.",
  request: { params: WorkParams },
  responses: [
    {
      status: 200,
      description: "the bursts, possibly none",
      body: closed({ bursts: Type.Array(Burst, { maxItems: 100_000 }) }),
    },
  ],
  errors: READ_ERRORS,
});

export const inputRhythmDelete = defineRoute({
  id: "work.input-rhythm.delete",
  method: "DELETE",
  path: "/api/v1/works/{documentId}/input-rhythm",
  inventory: WORK_INVENTORY,
  access: "student_owner",
  summary:
    "The student who owns the work deletes its recorded rhythm on request, also while the recording is off. No body. Answers 200 with the number of bursts deleted, possibly 0. Anyone but the owner of the work gets 404.",
  request: { params: WorkParams },
  responses: [
    {
      status: 200,
      description: "how many bursts were deleted",
      body: closed({ deleted: Type.Integer({ minimum: 0 }) }),
    },
  ],
  errors: WRITE_ERRORS,
});

export const inputRhythmSettingGet = defineRoute({
  id: "work.input-rhythm-setting.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/input-rhythm/setting",
  inventory: "app/api/works/[documentId]/input-rhythm/setting/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Whether the rhythm of typing is recorded for this work: the state of the teacher's switch of its assignment, on by default, with who changed it last (teacher or mentor, and the name when known) and when, both null while the default holds. The student reads it and cannot change it. The same answer for the owner and the readers of the work. Another's, an unknown or a malformed work returns 404.",
  request: { params: WorkParams },
  responses: [{ status: 200, description: "the state of the switch", body: SwitchState }],
  errors: READ_ERRORS,
});

export const teacherInputRhythmGet = defineRoute({
  id: "teacher.input-rhythm.get",
  method: "GET",
  path: "/api/v1/teacher/assignments/{assignmentId}/input-rhythm",
  inventory: TEACHER_INVENTORY,
  access: "course_teacher",
  summary:
    "The teacher of the assignment (of its course, or its mentor) reads the switch of the rhythm of typing, on by default, with who changed it last and when. A student, another teacher, an unknown or a malformed assignment returns 404.",
  request: { params: AssignmentParams },
  responses: [{ status: 200, description: "the state of the switch", body: SwitchState }],
  errors: READ_ERRORS,
});

export const teacherInputRhythmPut = defineRoute({
  id: "teacher.input-rhythm.put",
  method: "PUT",
  path: "/api/v1/teacher/assignments/{assignmentId}/input-rhythm",
  inventory: TEACHER_INVENTORY,
  access: "course_teacher",
  summary:
    "Only the teacher of the assignment (of its course, or its mentor) switches the recording of the rhythm of typing off or on for every work of it, exactly {enabled}. Switching off holds from that moment: nothing is recorded and nothing is read while it is off; what was recorded stays until it is deleted or due. Answers 200 with the new state and who changed it. Every switch is recorded in the audit trail in the same transaction. A body that is not exactly this is 422. A student, another teacher, an unknown or a malformed assignment returns 404.",
  request: {
    params: AssignmentParams,
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: Switch,
  },
  responses: [{ status: 200, description: "the new state of the switch", body: SwitchState }],
  errors: [...WRITE_ERRORS, ...BODY_ERRORS],
});

export const inputRhythmRoutes = [
  inputRhythmPost,
  inputRhythmGet,
  inputRhythmDelete,
  inputRhythmSettingGet,
  teacherInputRhythmGet,
  teacherInputRhythmPut,
] as const;
