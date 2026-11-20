import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1106 (Val 11, Ductus#2051; INVENTAR-editor E§3.5 mentor2 "Poruke", PO-22):
// the short messages next to a work. One conversation per work: its student and
// the teachers of its assignment read and write the same one, oldest first in
// the order of writing, so the order is the same on every reading. Ductus has
// no such route; the shape is the task's. Identity, role and institution are
// never in the body: the RPCs take them from the session, and the senderRole of
// a message is the relation the author had when writing it. Read through
// collaboration.list_work_messages (server/database/work-messages); reading
// writes no row of the access log, a message is not the student's text.

const CODE_POINT = "[\\uD800-\\uDBFF][\\uDC00-\\uDFFF]";
const END = "(?![\\s\\S])";
/** isDocumentId: 1 to 256 code points, trimmed, no control character (as live.ts). */
const WorkId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
/**
 * A message: 1 to 2000 code points with a non-space (as a comment). NFC, no
 * control character but newline and tab and no bidi control stay the server's
 * (422); an empty or blank message is refused and writes nothing.
 */
const MessageText = Type.String({
  pattern: `^(?=[\\s\\S]*\\S)(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,2000}${END}`,
});
const MessageId = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});

const Message = closed({
  id: MessageId,
  senderRole: Type.Union([Type.Literal("student"), Type.Literal("teacher")]),
  text: Type.String(),
  /** The instant of writing as Date.toISOString writes it, in UTC. */
  createdAt: Type.String({
    pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
  }),
});

export const workMessagesGet = defineRoute({
  id: "work.messages.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/messages",
  inventory: "app/api/works/[documentId]/messages/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The short messages of a work, oldest first in the order of writing (the same order on every reading), at most 1000: the same conversation for the student of the work and the teachers of its assignment. senderRole is the role the author had when writing. Another's, an unknown or a malformed work returns 404.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the conversation, possibly empty",
      body: closed({ messages: Type.Array(Message, { maxItems: 1000 }) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const workMessagesPost = defineRoute({
  id: "work.messages.post",
  method: "POST",
  path: "/api/v1/works/{documentId}/messages",
  inventory: "app/api/works/[documentId]/messages/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "Writes a short message to the conversation of a work: {text}, 1 to 2000 characters with a non-space, NFC, no control character but newline and tab, no bidi control, at most 4 KiB, sent as application/json. It answers 201 with the stored message, as the list gives it. An empty or blank message is 422 and writes nothing; so is the 1001st message of a work. The student of the work and the teachers of its assignment write; another's, an unknown or a malformed work returns 404.",
  request: {
    params: closed({ documentId: WorkId }),
    contentType: "application/json",
    maxBodyBytes: 4 * 1024,
    body: closed({ text: MessageText }),
  },
  responses: [{ status: 201, description: "the stored message", body: Message }],
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

export const workMessagesRoutes = [workMessagesGet, workMessagesPost] as const;
