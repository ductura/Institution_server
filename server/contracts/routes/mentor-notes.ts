import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

export const MentorshipNoteParams = closed({
  id: Type.String({
    pattern: `^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}${END}`,
  }),
});
const Body = Type.String({
  pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|[^\\u0000\\uD800-\\uDFFF]){1,4000}${END}`,
});
export const MentorNoteInput = closed({ body: Body });
const Note = closed({
  id: Type.String({ pattern: `^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}${END}` }),
  body: Body,
  createdAt: Type.String({ pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}` }),
});
const common = {
  path: "/api/v1/mentorships/{id}/notes",
  inventory: "app/api/mentorships/[id]/notes/route.ts",
  access: "teacher",
} as const;
const refusals = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];

export const mentorNotesGet = defineRoute({
  ...common,
  id: "mentorship.notes.get",
  method: "GET",
  summary: "List the current mentor's private notes for an active mentorship, oldest first.",
  request: { params: MentorshipNoteParams },
  responses: [
    {
      status: 200,
      description: "the mentor's own notes",
      body: closed({ notes: Type.Array(Note) }),
      headers: ["cache-control"],
    },
  ],
  errors: [...refusals, error(403, "forbidden")],
});

export const mentorNotesPost = defineRoute({
  ...common,
  id: "mentorship.notes.post",
  method: "POST",
  summary: "Add a private note as the current mentor of an active mentorship.",
  request: {
    params: MentorshipNoteParams,
    body: MentorNoteInput,
    contentType: "application/json",
    maxBodyBytes: 65_536,
  },
  responses: [
    { status: 201, description: "the created note", body: Note, headers: ["cache-control"] },
  ],
  errors: [
    ...MUTATION_GUARD,
    ...refusals,
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
  ],
});
