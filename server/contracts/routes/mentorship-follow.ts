import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-MENTOR-3 (Ductus#2055; NF-6 MK-8, MK-9, MK-11 and NF-5 PG-9; owner
// decisions of 23 Nov 2026): three reads and writes that follow a mentored
// work, none of which touches the document or its hash chain.
//
// (a) MK-9 "Poruka sebi" and "Dokle sam stao": the student's own note on a
//     work (at most 280 characters, an optional place in the work) and the
//     reading place, kept on the server so they follow the student to another
//     computer. Only the student who owns the work reads and writes them; to
//     anyone else, the mentor and the teachers included, the work is 404. A
//     place is a node of the document and an offset, never a quote.
// (c) MK-11 "student je vidio": a reader reports the published comments,
//     revision requests and messages it opened; the first instant stays. The
//     author of an item reads when the student of the work first opened it.
// (b) MK-8 "Moji studenti" (PG-9): the mentor's open mentorships in one read,
//     newest first as teacher.mentorships.get: the current stage, whom the
//     work waits on, the days to the next deadline and the student's messages
//     the mentor has not opened. No score, no rank, no comparison.
//
// Identity, role and institution are never in a request: the RPCs of
// 20261217100000 take them from the session (server/database/mentorship-follow).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as live.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** The instant as Date.toISOString writes it, in UTC. */
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});

/**
 * A place in a work: a node of the document (a UUID, as a text anchor's
 * nodeId) and an offset of 0 to 1000000 characters into it. Never text.
 */
export const WorkPlace = closed({
  nodeId: Type.String({
    pattern:
      "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$",
  }),
  offset: Type.Integer({ minimum: 0, maximum: 1_000_000 }),
});

/**
 * A note to oneself: 1 to 280 code points with a non-space. NFC, no control
 * character but newline and tab and no bidi control stay the server's (422).
 */
const NoteText = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,280}${END}`,
});

/** What the owner keeps on a work: either part may be absent. */
export const SelfNoteState = closed({
  note: Type.Union([
    closed({
      text: Type.String(),
      place: Type.Union([WorkPlace, Type.Null()]),
      updatedAt: Instant,
    }),
    Type.Null(),
  ]),
  readingPlace: Type.Union([closed({ place: WorkPlace, updatedAt: Instant }), Type.Null()]),
});

export const SelfNoteInput = closed({
  text: NoteText,
  place: Type.Optional(Type.Union([WorkPlace, Type.Null()])),
});
export const ReadingPlaceInput = closed({ place: WorkPlace });

const params = closed({ documentId: WorkId });
const readErrors = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];
const writeErrors = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
  error(404, "not_found"),
  error(503, "unavailable"),
];
const deleteErrors = [...MUTATION_GUARD, ...readErrors];
const OWNER_ONLY =
  "Only the student who owns the work; to anyone else, the mentor and the teachers of the work included, and for an unknown or malformed work it is 404.";

export const workSelfNoteGet = defineRoute({
  id: "work.self-note.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/self-note",
  inventory: "app/api/works/[documentId]/self-note/route.ts",
  access: "student_owner",
  summary: `The student's note to self (MK-9) and reading place on a work, null where none is kept. ${OWNER_ONLY}`,
  request: { params },
  responses: [{ status: 200, description: "what the owner keeps", body: SelfNoteState }],
  errors: readErrors,
});

export const workSelfNotePut = defineRoute({
  id: "work.self-note.put",
  method: "PUT",
  path: "/api/v1/works/{documentId}/self-note",
  inventory: "app/api/works/[documentId]/self-note/route.ts",
  access: "student_owner",
  summary: `Writes the note to self, replacing the earlier one: {text, place?}, text 1 to 280 characters with a non-space, NFC, no control character but newline and tab, no bidi control; place {nodeId, offset} or null. Answers what the owner keeps. ${OWNER_ONLY}`,
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: 4 * 1024,
    body: SelfNoteInput,
  },
  responses: [{ status: 200, description: "what the owner keeps", body: SelfNoteState }],
  errors: writeErrors,
});

export const workSelfNoteDelete = defineRoute({
  id: "work.self-note.delete",
  method: "DELETE",
  path: "/api/v1/works/{documentId}/self-note",
  inventory: "app/api/works/[documentId]/self-note/route.ts",
  access: "student_owner",
  summary: `Deletes the note to self; the reading place stays. Deleting what is not there changes nothing. Answers what the owner keeps. ${OWNER_ONLY}`,
  request: { params, maxBodyBytes: 0 },
  responses: [{ status: 200, description: "what the owner keeps", body: SelfNoteState }],
  errors: deleteErrors,
});

export const workReadingPlacePut = defineRoute({
  id: "work.reading-place.put",
  method: "PUT",
  path: "/api/v1/works/{documentId}/reading-place",
  inventory: "app/api/works/[documentId]/reading-place/route.ts",
  access: "student_owner",
  summary: `Writes the reading place (MK-9), replacing the earlier one: {place: {nodeId, offset}}. Answers what the owner keeps. ${OWNER_ONLY}`,
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: 1024,
    body: ReadingPlaceInput,
  },
  responses: [{ status: 200, description: "what the owner keeps", body: SelfNoteState }],
  errors: writeErrors,
});

export const workReadingPlaceDelete = defineRoute({
  id: "work.reading-place.delete",
  method: "DELETE",
  path: "/api/v1/works/{documentId}/reading-place",
  inventory: "app/api/works/[documentId]/reading-place/route.ts",
  access: "student_owner",
  summary: `Deletes the reading place; the note stays. Deleting what is not there changes nothing. Answers what the owner keeps. ${OWNER_ONLY}`,
  request: { params, maxBodyBytes: 0 },
  responses: [{ status: 200, description: "what the owner keeps", body: SelfNoteState }],
  errors: deleteErrors,
});

export const SEEN_ITEM_KINDS = [
  "comment",
  "revision_request",
  "milestone_revision",
  "message",
] as const;
const SeenKind = Type.Union(SEEN_ITEM_KINDS.map((kind) => Type.Literal(kind)));
const SeenMark = closed({ kind: SeenKind, id: Uuid, firstSeenAt: Instant });
export const SeenInput = closed({
  items: Type.Array(closed({ kind: SeenKind, id: Uuid }), { minItems: 1, maxItems: 200 }),
});
/** The most marks one read answers (list_work_items_seen_by_student). */
export const SEEN_MARKS_MAX = 5000;

export const workSeenPost = defineRoute({
  id: "work.seen.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/seen",
  inventory: "app/api/works/[documentId]/seen/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "A reader of the work reports the items it opened: {items: [{kind, id}]}, 1 to 200, kind comment (published), revision_request, milestone_revision or message. The first instant of opening stays; a later report changes nothing. An item that is not on the work, not visible to the caller or the caller's own is passed over. Answers every reported item that is kept, with its first instant. The student of the work and the teachers of its assignment report; for anyone else and an unknown or malformed work it is 404.",
  request: {
    params,
    contentType: "application/json",
    maxBodyBytes: 32 * 1024,
    body: SeenInput,
  },
  responses: [
    {
      status: 200,
      description: "the reported items that are kept",
      body: closed({ items: Type.Array(SeenMark, { maxItems: 200 }) }),
    },
  ],
  errors: writeErrors,
});

export const workSeenByStudentGet = defineRoute({
  id: "work.seen-by-student.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/seen-by-student",
  inventory: "app/api/works/[documentId]/seen-by-student/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The caller's own items of the work that its student has opened, with the instant of the first opening, oldest first, at most 5000 (MK-11). An item not yet opened, gone or no longer visible has no entry; the student reads an empty list. The student of the work and the teachers of its assignment read; for anyone else and an unknown or malformed work it is 404.",
  request: { params },
  responses: [
    {
      status: 200,
      description: "the caller's items the student has seen",
      body: closed({ items: Type.Array(SeenMark, { maxItems: SEEN_MARKS_MAX }) }),
    },
  ],
  errors: readErrors,
});

const MilestoneId = Uuid;
const MentorStudent = closed({
  mentorshipId: Uuid,
  assignmentId: Uuid,
  /** The student's work, null until the student opens it. */
  documentId: Type.Union([WorkId, Type.Null()]),
  givenName: Type.Union([Type.String(), Type.Null()]),
  familyName: Type.Union([Type.String(), Type.Null()]),
  workType: Type.Union([
    Type.Literal("bachelor_thesis"),
    Type.Literal("master_thesis"),
    Type.Literal("specialist_thesis"),
    Type.Literal("doctoral_thesis"),
  ]),
  title: Type.String(),
  /** The first milestone, in workflow order, that is not approved; null when none is left. */
  stage: Type.Union([
    closed({
      milestoneId: MilestoneId,
      title: Type.String(),
      position: Type.Integer({ minimum: 1 }),
      state: Type.Union([
        Type.Literal("not_submitted"),
        Type.Literal("submitted"),
        Type.Literal("revision_requested"),
      ]),
    }),
    Type.Null(),
  ]),
  stageCount: Type.Integer({ minimum: 0 }),
  waitingOn: Type.Union([Type.Literal("mentor"), Type.Literal("student"), Type.Literal("none")]),
  nextDeadlineAt: Type.Union([Instant, Type.Null()]),
  /** Calendar days in Europe/Zagreb to nextDeadlineAt, negative once it has passed. */
  daysToNextDeadline: Type.Union([Type.Integer(), Type.Null()]),
  newMessages: Type.Integer({ minimum: 0 }),
});

export const mentorshipOverviewGet = defineRoute({
  id: "mentorship.overview.get",
  method: "GET",
  path: "/api/v1/teacher/mentorship-overview",
  inventory: "app/api/teacher/mentorship-overview/route.ts",
  access: "mentor_teacher",
  summary:
    "MK-8: every open mentorship of the caller in one read, newest mentorship first (the order of teacher.mentorships.get; no score, no rank, no comparison of students). Each has the current stage, whom the work waits on (mentor: a submitted stage or a message of the student the caller has not opened; student: the work not opened, or the stage not submitted or under revision; none otherwise), the next deadline of a milestone that is not approved (a revision deadline first) with its days in Europe/Zagreb, and the number of the student's messages the caller has not opened. A caller who mentors nobody reads an empty list.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the caller's open mentorships",
      body: closed({ students: Type.Array(MentorStudent, { maxItems: 1000 }) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(503, "unavailable")],
});

export const selfNoteRoutes = [
  workSelfNoteGet,
  workSelfNotePut,
  workSelfNoteDelete,
  workReadingPlacePut,
  workReadingPlaceDelete,
] as const;
export const workSeenRoutes = [workSeenPost, workSeenByStudentGet] as const;
export const mentorshipFollowRoutes = [
  ...selfNoteRoutes,
  ...workSeenRoutes,
  mentorshipOverviewGet,
] as const;
