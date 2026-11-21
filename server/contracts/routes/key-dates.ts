import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { CODE_POINT, END } from "./teacher.ts";

const UUID_PATTERN = "^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}" + END;
const UUID = Type.String({ pattern: UUID_PATTERN });
const At = Type.String({
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z" + END,
});
export const KeyDatesParams = closed({
  id: Type.String({ pattern: UUID_PATTERN.replaceAll("a-f", "a-fA-F") }),
});

export const KeyDatesBody = closed({
  dates: Type.Array(
    Type.Union([
      closed({ kind: Type.Literal("deadline"), id: UUID, at: At }),
      closed({
        kind: Type.Literal("milestone"),
        id: UUID,
        at: At,
        title: Type.String({ pattern: `^(?:${CODE_POINT}|[^\\uD800-\\uDFFF]){1,200}${END}` }),
      }),
      closed({
        kind: Type.Literal("consultation"),
        id: UUID,
        at: At,
        state: Type.Union([
          Type.Literal("requested"),
          Type.Literal("countered"),
          Type.Literal("confirmed"),
        ]),
      }),
    ]),
  ),
});

export const keyDatesGet = defineRoute({
  id: "mentorship.key-dates.get",
  method: "GET",
  path: "/api/v1/mentorships/{id}/key-dates",
  inventory: "app/api/mentorships/[id]/key-dates/route.ts",
  access: "owner_or_mentor",
  summary:
    "The effective deadline, dated milestones and consultation slots of one active mentorship, in chronological order. Only its student and mentor may read.",
  request: { params: KeyDatesParams },
  responses: [
    {
      status: 200,
      description: "Dates ordered by instant, kind and id. The deadline id is the assignment id.",
      body: KeyDatesBody,
      headers: ["cache-control"],
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});
