import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

// SRV-1530 (Ductus#2052; N-14): the interview preparation of a work. There is
// no field for an outcome, a grade, a sanction or a suspicion, in the schema or
// anywhere else in these contracts: the interview is a preparation, not a
// proceeding. Whoever reads it reads the same: what the teacher side sees after
// the invitation, the student sees (D-249).
const PATH = "/api/v1/works/{documentId}/interview";
const INVENTORY = "app/api/works/[documentId]/interview/route.ts";
const SOURCE_PATH = (suffix: string) => `app/api/works/[documentId]/interview/${suffix}/route.ts`;
const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const Id = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}${END}`,
});
const DATE_TIME = "\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d";
const InputTime = Type.String({
  pattern: `^${DATE_TIME}(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)${END}`,
});
const Instant = Type.String({ pattern: `^${DATE_TIME}\\.\\d{3}Z${END}` });
const DateOnly = Type.String({
  pattern: `^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])${END}`,
});
const Text = (maxLength: number) => Type.String({ minLength: 1, maxLength });

/** The interview is kept 30 days without an invitation (O1); one constant, in SQL. */
export const WORK_INTERVIEW_DRAFT_DAYS = 30;

const Question = closed({
  id: Id,
  /** The paragraph the question is about; null is a general question. */
  paragraphRef: Type.Union([Text(256), Type.Null()]),
  questionText: Text(2000),
  createdAt: Instant,
  /** True for the caller's own question: before the invitation only those are read. */
  mine: Type.Boolean(),
});
const Explanation = closed({
  id: Id,
  questionId: Type.Union([Id, Type.Null()]),
  text: Text(2000),
  createdAt: Instant,
});
const Appointment = Type.Union([
  closed({ consultationSlotId: Id, startsAt: Instant }),
  closed({ place: Text(200), at: Instant }),
  Type.Null(),
]);
const Interview = closed({
  invitedAt: Type.Union([Instant, Type.Null()]),
  questions: Type.Array(Question, { maxItems: 50 }),
  explanations: Type.Array(Explanation, { maxItems: 100 }),
  appointment: Appointment,
  heldOn: Type.Union([DateOnly, Type.Null()]),
});

/** A note attached to the interview holds at most 1 MiB; the same constant is in SQL. */
export const WORK_INTERVIEW_NOTE_MAX_BYTES = 1_048_576;
const NOTE_BASE64_LENGTH = 4 * Math.ceil(WORK_INTERVIEW_NOTE_MAX_BYTES / 3);
const FILE_NAME_CHAR = `(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF/\\\\])`;
const FileName = Type.String({
  minLength: 1,
  maxLength: 200,
  pattern: `^(?!\\s)${FILE_NAME_CHAR}+(?<!\\s)${END}`,
});
const NoteMediaType = Type.Union([Type.Literal("text/plain"), Type.Literal("application/pdf")]);
const Note = closed({
  id: Id,
  fileName: FileName,
  mediaType: NoteMediaType,
  byteSize: Type.Integer({ minimum: 1, maximum: WORK_INTERVIEW_NOTE_MAX_BYTES }),
  sha256: Type.String({ pattern: `^[0-9a-f]{64}${END}` }),
  createdAt: Instant,
});

const errors = [
  error(401, "unauthorized"),
  error(403, "forbidden"),
  error(404, "not_found"),
  error(503, "unavailable"),
];
const mutationErrors = [
  ...errors,
  ...MUTATION_GUARD,
  error(400, "invalid_json"),
  error(415, "unsupported_media_type"),
  error(422, "invalid_input"),
];
// A mutation with no body is guarded by the origin checks only.
const originGuard = [
  error(403, "origin_missing"),
  error(403, "origin_mismatch"),
  error(403, "cross_site"),
];
const mutation = { contentType: "application/json", maxBodyBytes: 4096 } as const;
const params = closed({ documentId: DocumentId });

export const workInterviewRoutes = [
  defineRoute({
    id: "work.interview.get",
    method: "GET",
    path: PATH,
    inventory: INVENTORY,
    access: "owner_or_course_teacher",
    summary:
      "The interview preparation of an accessible work: questions, invitation, explanations, appointment and the date it was held. Before the invitation only the author of a question reads it and the owning student reads nothing (403). A work with no preparation answers an empty one.",
    request: { params },
    responses: [{ status: 200, description: "the preparation", body: Interview }],
    errors,
  }),
  defineRoute({
    id: "work.interview-questions.post",
    method: "POST",
    path: `${PATH}/questions`,
    inventory: SOURCE_PATH("questions"),
    access: "owner_or_course_teacher",
    summary:
      "A teacher or mentor of the work adds a question, about a paragraph or general (paragraphRef null or absent). At most 50 questions per work.",
    request: {
      ...mutation,
      params,
      body: closed({
        paragraphRef: Type.Optional(Type.Union([Text(256), Type.Null()])),
        questionText: Text(2000),
      }),
    },
    responses: [{ status: 201, description: "the question", body: Question }],
    errors: mutationErrors,
  }),
  defineRoute({
    id: "work.interview-questions.delete",
    method: "DELETE",
    path: `${PATH}/questions/{questionId}`,
    inventory: "app/api/works/[documentId]/interview/questions/[questionId]/route.ts",
    access: "owner_or_course_teacher",
    summary:
      "Removes a question: its author before the invitation, a teacher of the work after it. Anyone else, and an unknown question, get 403.",
    request: { params: closed({ documentId: DocumentId, questionId: Id }) },
    responses: [{ status: 204, description: "removed" }],
    errors: [...errors, ...originGuard],
  }),
  defineRoute({
    id: "work.interview-invite.post",
    method: "POST",
    path: `${PATH}/invite`,
    inventory: SOURCE_PATH("invite"),
    access: "owner_or_course_teacher",
    summary:
      "Makes the questions visible to the student from this instant and writes the invitation to the trail. A teacher with no question of their own, or a second invitation, is 409. No body.",
    request: { params },
    responses: [{ status: 200, description: "the preparation", body: Interview }],
    errors: [...errors, ...originGuard, error(409, "conflict")],
  }),
  defineRoute({
    id: "work.interview-appointment.put",
    method: "PUT",
    path: `${PATH}/appointment`,
    inventory: SOURCE_PATH("appointment"),
    access: "owner_or_course_teacher",
    summary:
      "Sets the appointment: a consultation slot of the work (the teacher, or the student after the invitation) or a free place and time ahead (the teacher). A held interview takes no new appointment (409).",
    request: {
      ...mutation,
      params,
      body: Type.Union([
        closed({ consultationSlotId: Id }),
        closed({ place: Text(200), at: InputTime }),
      ]),
    },
    responses: [{ status: 200, description: "the preparation", body: Interview }],
    errors: [...mutationErrors, error(409, "conflict")],
  }),
  defineRoute({
    id: "work.interview-held.post",
    method: "POST",
    path: `${PATH}/held`,
    inventory: SOURCE_PATH("held"),
    access: "owner_or_course_teacher",
    summary:
      "A teacher of the work notes the date the interview was held, once, after the invitation, not in the future. The outcome is not recorded here.",
    request: { ...mutation, params, body: closed({ date: DateOnly }) },
    responses: [{ status: 200, description: "the preparation", body: Interview }],
    errors: [...mutationErrors, error(409, "conflict")],
  }),
  defineRoute({
    id: "work.interview-explanations.post",
    method: "POST",
    path: `${PATH}/explanations`,
    inventory: SOURCE_PATH("explanations"),
    access: "student_owner",
    summary:
      "The owning student explains, in general or about one question, after the invitation. At most 100 explanations per work.",
    request: {
      ...mutation,
      params,
      body: closed({
        questionId: Type.Optional(Type.Union([Id, Type.Null()])),
        text: Text(2000),
      }),
    },
    responses: [{ status: 201, description: "the explanation", body: Explanation }],
    errors: mutationErrors,
  }),
  defineRoute({
    id: "work.interview-notes.post",
    method: "POST",
    path: `${PATH}/notes`,
    inventory: SOURCE_PATH("notes"),
    access: "student_owner",
    summary:
      "The owning student attaches a note to the preparation after the invitation: a UTF-8 text or a PDF of at most 1 MiB in standard Base64. The server derives the size and the SHA-256 and writes the attachment to the trail; the same bytes again answer the note already kept. Before the invitation, another student and a teacher get 403, a held interview 409, a work at 20 notes 422.",
    request: {
      contentType: "application/json",
      maxBodyBytes: NOTE_BASE64_LENGTH + 512,
      params,
      body: closed({
        fileName: FileName,
        mediaType: NoteMediaType,
        contentBase64: Type.String({
          minLength: 4,
          maxLength: NOTE_BASE64_LENGTH,
          pattern: `^[A-Za-z0-9+/]+={0,2}${END}`,
        }),
      }),
    },
    responses: [{ status: 201, description: "the note", body: Note }],
    errors: [...mutationErrors, error(409, "conflict")],
  }),
] as const;
