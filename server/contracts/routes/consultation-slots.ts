import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { SLOT_TOPIC_MAX, Text } from "./mentorship-consultations.ts";
import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const PATH = "/api/v1/works/{documentId}/consultation-slots";
const INVENTORY = "app/api/works/[documentId]/consultation-slots/route.ts";
const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
const SlotId = Type.String({
  pattern: `^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}${END}`,
});
const DATE_TIME = "\\d{4}-\\d{2}-\\d{2}T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d";
const InputTime = Type.String({
  pattern: `^${DATE_TIME}(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)${END}`,
});
const Instant = Type.String({ pattern: `^${DATE_TIME}\\.\\d{3}Z${END}` });
const Slot = closed({
  id: SlotId,
  startsAt: Instant,
  proposedAt: Instant,
  state: Type.Union([
    Type.Literal("requested"),
    Type.Literal("countered"),
    Type.Literal("confirmed"),
  ]),
  /**
   * SRV-KONZ-STANJA (1.113.0): the topic the student gave with the request, or
   * null for none. Optional only so that a client of 1.112.0 stays valid; the
   * server always sends it.
   */
  topic: Type.Optional(Type.Union([Text(SLOT_TOPIC_MAX), Type.Null()])),
});
// SRV-KONZ-STANJA (1.113.0): post takes an optional topic (1 to 200 code points,
// not blank; NFC, control and bidi characters are the server's 422) and every
// answer carries it. The list keeps only requested, countered and confirmed;
// withdraw, decline and cancel are work.consultation-slot-close.post and a
// closed slot is read by work.consultation-slot-details.get. A route summary
// is part of the published contract (contracts:breaking), so it stays as is.
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
const mutation = { contentType: "application/json", maxBodyBytes: 1024 } as const;

export const consultationSlotRoutes = [
  defineRoute({
    id: "work.consultation-slots.get",
    method: "GET",
    path: PATH,
    inventory: INVENTORY,
    access: "owner_or_course_teacher",
    summary:
      "List the consultation slots of an accessible work, ordered by startsAt and id. proposedAt is the instant the student first requested the slot.",
    request: { params: closed({ documentId: DocumentId }) },
    responses: [
      { status: 200, description: "the slots", body: closed({ slots: Type.Array(Slot) }) },
    ],
    errors,
  }),
  defineRoute({
    id: "work.consultation-slots.post",
    method: "POST",
    path: PATH,
    inventory: INVENTORY,
    access: "student_owner",
    summary: "The owning student requests a consultation at the given time.",
    request: {
      ...mutation,
      params: closed({ documentId: DocumentId }),
      body: closed({ startsAt: InputTime, topic: Type.Optional(Text(SLOT_TOPIC_MAX)) }),
    },
    responses: [{ status: 201, description: "the requested slot", body: Slot }],
    errors: mutationErrors,
  }),
  defineRoute({
    id: "work.consultation-slots.patch",
    method: "PATCH",
    path: `${PATH}/{slotId}`,
    inventory: "app/api/works/[documentId]/consultation-slots/[slotId]/route.ts",
    access: "owner_or_course_teacher",
    summary:
      "The teacher confirms or replaces startsAt with a counter-proposal. The owning student accepts that time. proposedAt remains the instant of the original request.",
    request: {
      ...mutation,
      params: closed({ documentId: DocumentId, slotId: SlotId }),
      body: Type.Union([
        closed({ action: Type.Literal("confirm") }),
        closed({ action: Type.Literal("counter"), startsAt: InputTime }),
        closed({ action: Type.Literal("accept") }),
      ]),
    },
    responses: [{ status: 200, description: "the updated slot", body: Slot }],
    errors: [...mutationErrors, error(409, "conflict")],
  }),
] as const;
