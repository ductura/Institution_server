// SRV-MENTOR-1 (Ductus#2055; owner decisions of 23 Nov 2026 for NF-6: MK-7,
// MK-3, MK-10, MK-5). Every route here is new; the routes they stand next to
// keep their contracts, so no client of theirs meets a new field or state:
//
//   mentorship.open.post                     the teacher opens a mentorship (MK-7)
//   mentorship.student-mentorships.get       the student's open mentorships
//   notifications.mentorship-opened.list.get the student's notice of an opening;
//                                            notifications.list.get leaves the new
//                                            kind out, as with returned_for_revision
//   work.consultation-slot-details.get       slots with topic, closing and preparation
//   work.consultation-slot-requests.post     a request with topic and preparation (MK-3, MK-10)
//   work.consultation-slot-close.post        withdraw, decline or cancel (MK-3)
//   work.consultation-tasks.get              agreed tasks of the records (MK-5)
//   work.consultation-tasks.post             the teacher of the work adds one
//   work.consultation-task-mark.post         the teacher of the work marks one
//
// Access comes from the relation to the work or the mentorship (C-23); the
// database decides. Identity and role are never in a body. A preparation is a
// record of input, never of authorship; nothing here draws a conclusion about
// who wrote a text.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { NotificationId, NOTIFICATIONS_PAGE_SIZE } from "./notifications.ts";
import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END, Name } from "./teacher.ts";

/** 1 to max code points with a non-space; NFC, control and bidi characters stay the server's (422). */
export const Text = (max: number) =>
  Type.String({ pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,${max}}${END}` });
/** A UUID in any case; the server reads it in lowercase. */
const AnyCaseUuid = Type.String({
  pattern: `^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}${END}`,
});
/** Lowercase UUID, as the database returns it. */
const Uuid = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}${END}`,
});
const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const DATE_TIME = "\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d";
const InputTime = Type.String({
  pattern: `^${DATE_TIME}(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)${END}`,
});
const Instant = Type.String({ pattern: `^${DATE_TIME}\\.\\d{3}Z${END}` });
const Minute = Type.String({ pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z${END}` });
const WorkType = Type.Union([
  Type.Literal("bachelor_thesis"),
  Type.Literal("master_thesis"),
  Type.Literal("specialist_thesis"),
  Type.Literal("doctoral_thesis"),
]);
/** The mentor's name pair, or null when the institution holds none. */
const MentorName = Type.Union([closed({ givenName: Name, familyName: Name }), Type.Null()]);

export const MENTORSHIP_TOPIC_MAX = 300;
export const SLOT_TOPIC_MAX = 200;
export const CLOSING_REASON_MAX = 600;
export const PREPARATION_TEXT_MAX = 4000;
export const PREPARATION_COUNT_MAX = 100_000;
export const TASK_TEXT_MAX = 500;
export const TASKS_PER_RECORD = 20;

const json = { contentType: "application/json" } as const;
/** The refusals of a body; 401 is in each route's own list. */
const BODY_ERRORS = [
  ...MUTATION_GUARD,
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
] as const;

// (a) MK-7 -------------------------------------------------------------------

const StudentMentorship = closed({
  mentorshipId: Uuid,
  /** The assignment of the mentorship's work; join it to student.assignments.get. */
  assignmentId: Type.Union([Uuid, Type.Null()]),
  workType: WorkType,
  /** The topic the teacher gave on opening; null for none and for an approved request. */
  topic: Type.Union([Text(MENTORSHIP_TOPIC_MAX), Type.Null()]),
  mentorId: Uuid,
  mentorName: MentorName,
  startedAt: Instant,
  /** Who began it: the teacher opened it, or the teacher approved the student's request. */
  openedBy: Type.Union([Type.Literal("teacher"), Type.Literal("request")]),
});

const MentorshipNotification = closed({
  id: NotificationId,
  /** The opened mentorship. */
  targetId: Uuid,
  workType: WorkType,
  topic: Type.Union([Text(MENTORSHIP_TOPIC_MAX), Type.Null()]),
  mentorName: MentorName,
  createdAt: Instant,
  readAt: Type.Union([Instant, Type.Null()]),
});
export const MentorshipNotificationsPage = closed({
  notifications: Type.Array(MentorshipNotification, { maxItems: NOTIFICATIONS_PAGE_SIZE }),
  nextBefore: Type.Union([NotificationId, Type.Null()]),
});

export const mentorshipOpenPost = defineRoute({
  id: "mentorship.open.post",
  method: "POST",
  path: "/api/v1/mentorships",
  inventory: "app/api/mentorships/route.ts",
  access: "teacher",
  summary:
    "The confirmed teacher opens a mentorship of a kind of work for a student of the own institution, with an optional topic (1 to 300 code points, not blank). The mentorship, its work and the first version exist from the commit on, and the student gets one notification (notifications.mentorship-opened.list.get). The student does not ask; an older student request stays as it is. A student who is unknown, of another institution, holds a confirmed teacher role or is the caller, and a caller who is no confirmed teacher, read 404; an open mentorship of the kind is 409; a missing faculty rule for the kind is 503.",
  request: {
    ...json,
    maxBodyBytes: 4096,
    body: closed({
      studentId: AnyCaseUuid,
      workType: WorkType,
      topic: Type.Optional(Text(MENTORSHIP_TOPIC_MAX)),
    }),
  },
  responses: [
    {
      status: 201,
      description: "the opened mentorship",
      body: closed({ mentorshipId: Uuid }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    ...BODY_ERRORS,
    error(404, "not_found"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const studentMentorshipsGet = defineRoute({
  id: "mentorship.student-mentorships.get",
  method: "GET",
  path: "/api/v1/student/mentorships",
  inventory: "app/api/student/mentorships/route.ts",
  access: "student",
  summary:
    "The caller's own open mentorships as their student, newest first: the kind of work, the assignment, the topic of an opening, the mentor and whether the teacher opened it or approved a request. A caller with a confirmed teacher role is 403.",
  request: {},
  responses: [
    {
      status: 200,
      description: "own open mentorships, possibly none",
      body: closed({ mentorships: Type.Array(StudentMentorship) }),
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
});

export const mentorshipNotificationsGet = defineRoute({
  id: "notifications.mentorship-opened.list.get",
  method: "GET",
  path: "/api/v1/notifications/mentorship-opened",
  inventory: "app/api/notifications/mentorship-opened/route.ts",
  access: "signed_in",
  summary:
    "The signed-in student's notifications that a teacher opened a mentorship for them, newest first, each with the kind of work, the topic and the mentor. Only the student of the mentorship sees one. Start without a cursor; pass nextBefore as before to continue. Mark one read with notifications.read.post. notifications.list.get leaves these out.",
  request: { query: closed({ before: Type.Optional(NotificationId) }) },
  responses: [
    {
      status: 200,
      description: "one page of notifications",
      body: MentorshipNotificationsPage,
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

// (b) and (c) MK-3, MK-10 ----------------------------------------------------

const SLOTS = "/api/v1/works/{documentId}";
const SlotId = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}${END}`,
});
const Count = Type.Integer({ minimum: 0, maximum: PREPARATION_COUNT_MAX });
const Preparation = closed({
  /** What the student brings, up to 4000 code points: a record of input, not of authorship. */
  text: Text(PREPARATION_TEXT_MAX),
  changedParagraphs: Count,
  resolvedComments: Count,
});
const Closing = closed({
  by: Type.Union([Type.Literal("student"), Type.Literal("teacher")]),
  reason: Type.Union([Text(CLOSING_REASON_MAX), Type.Null()]),
  at: Instant,
});
export const SlotDetail = closed({
  id: SlotId,
  startsAt: Instant,
  proposedAt: Instant,
  state: Type.Union([
    Type.Literal("requested"),
    Type.Literal("countered"),
    Type.Literal("confirmed"),
    Type.Literal("withdrawn"),
    Type.Literal("declined"),
    Type.Literal("cancelled"),
  ]),
  topic: Type.Union([Text(SLOT_TOPIC_MAX), Type.Null()]),
  /** Who closed the slot, why and when; null while it is open. */
  closing: Type.Union([Closing, Type.Null()]),
  /** The student's preparation; null when none was attached. */
  preparation: Type.Union([Preparation, Type.Null()]),
});
const SLOT_ERRORS = [
  error(401, "unauthorized"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;

export const slotDetailsGet = defineRoute({
  id: "work.consultation-slot-details.get",
  method: "GET",
  path: `${SLOTS}/consultation-slot-details`,
  inventory: "app/api/works/[documentId]/consultation-slot-details/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Every consultation slot of the work, closed ones included, ordered by startsAt and id, with the topic, the closing and the preparation. Only the student who owns the work and the teacher of the work read it; anyone else is 403. work.consultation-slots.get stays as it is and leaves closed slots out.",
  request: { params: closed({ documentId: DocumentId }) },
  responses: [
    {
      status: 200,
      description: "the slots",
      body: closed({ slots: Type.Array(SlotDetail) }),
      headers: ["cache-control"],
    },
  ],
  errors: SLOT_ERRORS,
});

export const slotRequestPost = defineRoute({
  id: "work.consultation-slot-requests.post",
  method: "POST",
  path: `${SLOTS}/consultation-slot-requests`,
  inventory: "app/api/works/[documentId]/consultation-slot-requests/route.ts",
  access: "student_owner",
  summary:
    "The owning student requests a consultation at a time within a year, with an optional topic (1 to 200 code points) and an optional preparation: a text of up to 4000 code points and the counts of changed paragraphs and resolved comments, all three or none. The preparation is a record of input, not of authorship; only the student and the teacher of the work read it. At most 20 open requests a work (422).",
  request: {
    ...json,
    maxBodyBytes: 32 * 1024,
    params: closed({ documentId: DocumentId }),
    body: closed({
      startsAt: InputTime,
      topic: Type.Optional(Text(SLOT_TOPIC_MAX)),
      preparation: Type.Optional(Preparation),
    }),
  },
  responses: [
    {
      status: 201,
      description: "the requested slot",
      body: SlotDetail,
      headers: ["cache-control"],
    },
  ],
  errors: [...SLOT_ERRORS, ...BODY_ERRORS],
});

export const slotClosePost = defineRoute({
  id: "work.consultation-slot-close.post",
  method: "POST",
  path: `${SLOTS}/consultation-slots/{slotId}/close`,
  inventory: "app/api/works/[documentId]/consultation-slots/[slotId]/close/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Closes a consultation slot, with an optional reason (1 to 600 code points). withdraw: the owning student, while the teacher has not answered (requested). decline: the teacher of the work, while requested. cancel: either side, a countered or confirmed slot whose time lies ahead. The wrong side is 403, a state that does not allow the move 409.",
  request: {
    ...json,
    maxBodyBytes: 8192,
    params: closed({ documentId: DocumentId, slotId: SlotId }),
    body: closed({
      action: Type.Union([
        Type.Literal("withdraw"),
        Type.Literal("decline"),
        Type.Literal("cancel"),
      ]),
      reason: Type.Optional(Text(CLOSING_REASON_MAX)),
    }),
  },
  responses: [
    { status: 200, description: "the closed slot", body: SlotDetail, headers: ["cache-control"] },
  ],
  errors: [...SLOT_ERRORS, ...BODY_ERRORS, error(409, "conflict")],
});

// (d) MK-5 -------------------------------------------------------------------

const RecordId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
export const ConsultationTask = closed({
  id: Uuid,
  recordId: Uuid,
  position: Type.Integer({ minimum: 1, maximum: TASKS_PER_RECORD }),
  text: Text(TASK_TEXT_MAX),
  done: Type.Boolean(),
  /** The whole UTC minute of the newest mark; null when never marked. */
  markedAt: Type.Union([Minute, Type.Null()]),
  createdAt: Minute,
});
const TASK_READ_ERRORS = [
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;
const TASK_WRITE_ERRORS = [...TASK_READ_ERRORS, ...BODY_ERRORS] as const;

export const consultationTasksGet = defineRoute({
  id: "work.consultation-tasks.get",
  method: "GET",
  path: `${SLOTS}/consultation-tasks`,
  inventory: "app/api/works/[documentId]/consultation-tasks/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The agreed tasks of every consultation record of the work, by record (oldest meeting first) and position, each with its state (the newest mark). The same list for the student who owns the work and the teacher of the work; another's, an unknown or a malformed work is 404.",
  request: { params: closed({ documentId: DocumentId }) },
  responses: [
    {
      status: 200,
      description: "the tasks, possibly none",
      body: closed({ tasks: Type.Array(ConsultationTask, { maxItems: 200_000 }) }),
      headers: ["cache-control"],
    },
  ],
  errors: TASK_READ_ERRORS,
});

export const consultationTasksPost = defineRoute({
  id: "work.consultation-tasks.post",
  method: "POST",
  path: `${SLOTS}/consultation-records/{recordId}/tasks`,
  inventory: "app/api/works/[documentId]/consultation-records/[recordId]/tasks/route.ts",
  access: "mentor_teacher",
  summary:
    "The teacher of the work (the mentor) adds an agreed task to a consultation record of the work: exactly {text}, 1 to 500 code points, not blank. At most 20 a record (422). The student reads the tasks and never writes them; for the student, another's work and a record of another work this is 404. A task is never changed or deleted.",
  request: {
    ...json,
    maxBodyBytes: 4096,
    params: closed({ documentId: DocumentId, recordId: RecordId }),
    body: closed({ text: Text(TASK_TEXT_MAX) }),
  },
  responses: [
    {
      status: 201,
      description: "the new task",
      body: ConsultationTask,
      headers: ["cache-control"],
    },
  ],
  errors: TASK_WRITE_ERRORS,
});

export const consultationTaskMarkPost = defineRoute({
  id: "work.consultation-task-mark.post",
  method: "POST",
  path: `${SLOTS}/consultation-tasks/{taskId}/mark`,
  inventory: "app/api/works/[documentId]/consultation-tasks/[taskId]/mark/route.ts",
  access: "mentor_teacher",
  summary:
    "The teacher of the work marks an agreed task done or not done: exactly {done}. A mark is added, never changed; a mark equal to the current state adds nothing. For the student and anyone else this is 404.",
  request: {
    ...json,
    maxBodyBytes: 1024,
    params: closed({ documentId: DocumentId, taskId: RecordId }),
    body: closed({ done: Type.Boolean() }),
  },
  responses: [
    { status: 200, description: "the task", body: ConsultationTask, headers: ["cache-control"] },
  ],
  errors: TASK_WRITE_ERRORS,
});

export const mentorshipConsultationRoutes = [
  mentorshipOpenPost,
  studentMentorshipsGet,
  mentorshipNotificationsGet,
  slotDetailsGet,
  slotRequestPost,
  slotClosePost,
  consultationTasksGet,
  consultationTasksPost,
  consultationTaskMarkPost,
] as const;
