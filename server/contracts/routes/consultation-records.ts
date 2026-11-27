import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1105 (Ductus#2051, wave 11; N-12, D-47, PO-22): the shared record of a
// consultation about one work and the additions to it. The teacher of the
// work's assignment and the student who owns it read the same list and write
// to the same record (the relation of the comments); another's, an unknown or
// a malformed work answers 404 (C-23). Identity, role and author are never in
// the body: the functions take them from the session. A record and an
// addition are only added, never changed. The time of an addition is a whole
// UTC minute (D-24).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as versions.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const RecordId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
/** A calendar date; that it exists is the server's (422). */
const HeldOn = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}$" });
const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
/** 1 to 200 code points with a non-space; NFC, control and bidi characters stay the server's (422). */
const Topic = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,200}${END}`,
});
/** 0 to 2000 code points. */
const Agreement = Type.String({ pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){0,2000}${END}` });
/** 1 to 2000 code points with a non-space. */
const AdditionText = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,2000}${END}`,
});
const Minute = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:00\\.000Z$" });
/**
 * F4 wave 2 #2 (1.3): the time the meeting was held, an optional field of the
 * body besides the four the summary names (the summary text stays as it is,
 * since a changed summary reads as a break). An ISO UTC instant to the minute,
 * second or millisecond, stored and read back as a whole minute; null or
 * absent for none. More than 5 minutes ahead, or more than a day from heldOn,
 * is the server's 422.
 */
const HeldAtInput = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?Z$",
  description:
    "The time the meeting was held, ISO UTC; kept as a whole minute. More than 5 minutes ahead or more than a day from heldOn is 422.",
});

const Addition = closed({ id: RecordId, text: AdditionText, createdAt: Minute });
const ConsultationRecord = closed({
  id: RecordId,
  heldOn: HeldOn,
  revision: Revision,
  topic: Topic,
  agreement: Agreement,
  additions: Type.Array(Addition, { maxItems: 10_000 }),
  /** F4 wave 2 #2: the minute the meeting was held; null when none was given. */
  heldAt: Type.Optional(Type.Union([Minute, Type.Null()])),
});

const WRITE_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
  error(404, "not_found"),
  error(503, "unavailable"),
] as const;

export const consultationRecordsGet = defineRoute({
  id: "work.consultation-records.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/consultation-records",
  inventory: "app/api/works/[documentId]/consultation-records/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The consultation records of a work, oldest meeting first, each with its additions in the order they were made. The same list for the owner and the teacher of the assignment. Another's, an unknown or a malformed work returns 404.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the records, possibly none",
      body: closed({ records: Type.Array(ConsultationRecord, { maxItems: 10_000 }) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const consultationRecordsPost = defineRoute({
  id: "work.consultation-records.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/consultation-records",
  inventory: "app/api/works/[documentId]/consultation-records/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Records a consultation about a work: the day it was held, the revision it is about (a revision of the same work), a topic and the agreement. Exactly those four fields, at most 8 KiB. An empty topic, a date that does not exist or a revision of another work is 422. Answers 201 with the record, which has no additions yet.",
  request: {
    params: closed({ documentId: WorkId }),
    contentType: "application/json",
    maxBodyBytes: 8 * 1024,
    body: closed({
      heldOn: HeldOn,
      revision: Revision,
      topic: Topic,
      agreement: Agreement,
      heldAt: Type.Optional(Type.Union([HeldAtInput, Type.Null()])),
    }),
  },
  responses: [{ status: 201, description: "the new record", body: ConsultationRecord }],
  errors: WRITE_ERRORS,
});

export const consultationAdditionsPost = defineRoute({
  id: "work.consultation-additions.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/consultation-records/{recordId}/additions",
  inventory: "app/api/works/[documentId]/consultation-records/[recordId]/additions/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Adds a text to a consultation record of the work. Exactly {text}, at most 8 KiB. An empty or blank text is 422; a record that is not this work's reads as 404. Answers 201 with the addition and its whole-minute time.",
  request: {
    params: closed({ documentId: WorkId, recordId: RecordId }),
    contentType: "application/json",
    maxBodyBytes: 8 * 1024,
    body: closed({ text: AdditionText }),
  },
  responses: [{ status: 201, description: "the new addition", body: Addition }],
  errors: WRITE_ERRORS,
});

export const consultationRecordsRoutes = [
  consultationRecordsGet,
  consultationRecordsPost,
  consultationAdditionsPost,
] as const;
