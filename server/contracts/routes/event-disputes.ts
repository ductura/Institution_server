import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1315 (Ductus#2052; plan M7.8, R-08): the HTTP layer over SRV-1314. The
// student who owns a work amends or disputes the description of one event of
// its process summary; the owner and the readers of the work (the teacher of
// the course, the teacher of the seminar group, the mentor) read the records.
// A record is only added and sits beside the summary: the summary and the
// receipt are unchanged, the client shows a record next to its event. Who asks
// and the institution come only from the session. A reader who is not the
// owner reads 403 on POST; another's, an unknown or a malformed work reads 404
// (C-23).

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as consultation-records.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const DisputeId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const Kind = Type.Union([Type.Literal("amendment"), Type.Literal("dispute")]);
/** The event id as the summary names it: 1 to 128 characters of [a-z0-9_.:/-] starting with a letter. */
const EventId = Type.String({ pattern: "^[a-z][a-z0-9_.:/-]{0,127}$" });
/** 1 to 1000 code points with a non-space; control and bidi characters stay the server's (422). */
const Text = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,1000}${END}`,
});
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

const Dispute = closed({
  disputeId: DisputeId,
  kind: Kind,
  eventId: EventId,
  text: Text,
  createdAt: Instant,
});

export const eventDisputesGet = defineRoute({
  id: "work.event-disputes.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/event-disputes",
  inventory: "app/api/works/[documentId]/event-disputes/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The amendments and disputes of the events of a work's process summary, oldest first, for the student who owns the work and for the readers of it. The process summary itself is unchanged. Another's, an unknown or a malformed work returns 404.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the records, possibly none",
      body: closed({ disputes: Type.Array(Dispute, { maxItems: 10_000 }) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const eventDisputesPost = defineRoute({
  id: "work.event-disputes.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/event-disputes",
  inventory: "app/api/works/[documentId]/event-disputes/route.ts",
  access: "student_owner",
  summary:
    "The student who owns the work amends or disputes one event of its process summary: exactly {kind, eventId, text}, at most 4 KiB. A kind other than amendment or dispute, an event id that is not one or a text of no characters, only blanks or over 1000 characters is 422. A reader of the work who is not its owner is 403; another's, an unknown or a malformed work is 404. Answers 201 with the id and the time of the record; the process summary is unchanged.",
  request: {
    params: closed({ documentId: WorkId }),
    contentType: "application/json",
    maxBodyBytes: 4 * 1024,
    body: closed({ kind: Kind, eventId: EventId, text: Text }),
  },
  responses: [
    {
      status: 201,
      description: "the new record",
      body: closed({ disputeId: DisputeId, createdAt: Instant }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const eventDisputesRoutes = [eventDisputesGet, eventDisputesPost] as const;
