import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

const DocumentId = Type.String({
  pattern: `^(?!\\s)(?:${CODE_POINT}|[^\\u0000-\\u001f\\u007f-\\u009f\\uD800-\\uDFFF]){1,256}(?<!\\s)${END}`,
});
export const WorkMilestoneId = Type.String({
  pattern: `^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}${END}`,
});
const Instant = Type.String({
  pattern: `^\\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\\d|3[01])T(?:[01]\\d|2[0-3]):[0-5]\\d:[0-5]\\d(?:\\.\\d{1,3})?(?:Z|[+-](?:[01]\\d|2[0-3]):[0-5]\\d)${END}`,
});
const WorkMilestone = closed({
  id: WorkMilestoneId,
  title: Type.String({ minLength: 1, maxLength: 200 }),
  description: Type.String({ maxLength: 2000 }),
  dueAt: Type.Union([Instant, Type.Null()]),
  state: Type.Union([
    Type.Literal("open"),
    Type.Literal("submitted"),
    Type.Literal("approved"),
    Type.Literal("returned"),
  ]),
});
export const WorkMilestoneDueInput = closed({ dueAt: Instant });

const readErrors = [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")];

export const workMilestonesGet = defineRoute({
  id: "work.milestones.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/milestones",
  inventory: "app/api/works/[documentId]/milestones/route.ts",
  access: "owner_or_course_teacher",
  summary: "The configured milestones of one work, in workflow order, for its owner and teachers.",
  request: { params: closed({ documentId: DocumentId }) },
  responses: [
    {
      status: 200,
      description: "Configured milestones with the current deadlines of this work",
      body: closed({ milestones: Type.Array(WorkMilestone, { maxItems: 100 }) }),
    },
  ],
  errors: readErrors,
});

export const workMilestonePatch = defineRoute({
  id: "work.milestones.patch",
  method: "PATCH",
  path: "/api/v1/works/{documentId}/milestones/{milestoneId}",
  inventory: "app/api/works/[documentId]/milestones/[milestoneId]/route.ts",
  access: "course_teacher",
  summary: "A teacher changes the deadline of one configured milestone of an unsubmitted work.",
  request: {
    params: closed({ documentId: DocumentId, milestoneId: WorkMilestoneId }),
    contentType: "application/json",
    body: WorkMilestoneDueInput,
    maxBodyBytes: 256,
  },
  responses: [{ status: 200, description: "Updated milestone", body: WorkMilestone }],
  errors: [
    ...MUTATION_GUARD,
    ...readErrors,
    error(400, "invalid_json"),
    error(403, "forbidden"),
    error(409, "conflict"),
    error(415, "unsupported_media_type"),
    error(422, "invalid_input"),
  ],
});

export const workMilestonesRoutes = [workMilestonesGet, workMilestonePatch] as const;
