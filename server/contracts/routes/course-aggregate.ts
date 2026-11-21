import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

export const CourseAggregateParams = closed({
  id: Type.String({
    pattern: "^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}(?![\\s\\S])",
  }),
});

const Count = Type.Integer({ minimum: 0 });
const CourseAggregate = Type.Union([
  closed({ status: Type.Literal("suppressed") }),
  closed({
    status: Type.Literal("available"),
    started: Count,
    submitted: Count,
    stages: closed({ not_started: Count, in_progress: Count, submitted: Count }),
  }),
]);
export type CourseAggregate = Static<typeof CourseAggregate>;

export const courseAggregateGet = defineRoute({
  id: "course.aggregate.get",
  method: "GET",
  path: "/api/v1/courses/{id}/aggregate",
  inventory: "app/api/courses/[id]/aggregate/route.ts",
  access: "course_teacher",
  summary:
    "Whole-course snapshot for a course teacher. A student counts once at the furthest work stage. Started includes submitted. Suppresses all counts for fewer than five students, incomplete course access, or any nonempty stage below five. No filters.",
  request: { params: CourseAggregateParams, query: closed({}) },
  responses: [{ status: 200, description: "aggregate or suppressed", body: CourseAggregate }],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});
