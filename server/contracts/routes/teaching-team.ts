import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

const Uuid = Type.String({
  pattern:
    "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}(?![\\s\\S])",
});
const MemberIds = Type.Array(Uuid, { maxItems: 500 });
const PATH = "/api/v1/courses/{id}";
const INVENTORY = "app/api/courses/[id]";
const ERRORS = [
  error(401, "unauthorized"),
  error(403, "forbidden"),
  error(422, "invalid_input"),
  error(503, "unavailable"),
] as const;
const WRITE_ERRORS = [
  ...ERRORS,
  ...MUTATION_GUARD,
  error(400, "invalid_json"),
  error(415, "unsupported_media_type"),
] as const;
const JSON_BODY = { contentType: "application/json", maxBodyBytes: 40_960 } as const;
const UPDATED = {
  status: 200,
  description: "membership replaced",
  body: closed({ updated: Type.Literal(true) }),
} as const;

export const teachingTeamRoutes = [
  defineRoute({
    id: "institution.teaching-team.get",
    method: "GET",
    path: `${PATH}/team`,
    inventory: `${INVENTORY}/team/route.ts`,
    access: "course_teacher",
    summary:
      "The current holder and active assistants, readable by the holder and active assistants.",
    request: { params: closed({ id: Uuid }) },
    responses: [
      {
        status: 200,
        description: "the teaching team",
        body: closed({ holderId: Type.Union([Uuid, Type.Null()]), assistantIds: MemberIds }),
      },
    ],
    errors: ERRORS,
  }),
  defineRoute({
    id: "institution.teaching-team.post",
    method: "POST",
    path: `${PATH}/team`,
    inventory: `${INVENTORY}/team/route.ts`,
    access: "course_teacher",
    summary:
      "The holder replaces the entire assistant roster with distinct IDs. Omitting an assistant ends all their group places in the course. Adding an assistant alone grants no access to works.",
    request: {
      ...JSON_BODY,
      params: closed({ id: Uuid }),
      body: closed({ assistantIds: MemberIds }),
    },
    responses: [UPDATED],
    errors: WRITE_ERRORS,
  }),
  defineRoute({
    id: "institution.teaching-group-members.put",
    method: "PUT",
    path: `${PATH}/groups/{groupId}/members`,
    inventory: `${INVENTORY}/groups/[groupId]/members/route.ts`,
    access: "course_teacher",
    summary:
      "The holder replaces the group's assistant and student lists atomically. Each list has distinct IDs. Assistants must be on the roster and students enrolled in the course. A student with a place in another group causes 409.",
    request: {
      ...JSON_BODY,
      params: closed({ id: Uuid, groupId: Uuid }),
      body: closed({ assistantIds: MemberIds, studentIds: MemberIds }),
    },
    responses: [UPDATED],
    errors: [...WRITE_ERRORS, error(409, "conflict")],
  }),
] as const;
