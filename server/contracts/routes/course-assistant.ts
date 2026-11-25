import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-ASIST-PREKIDAC (Ductus#2055 c.7162920212, T4): the switch "Asistent
// uključen" per course, on by default. A teacher of the course reads and sets
// it; a student of an assignment reads whether the assistant is available for
// it: a provider exists, the institution has a published cost configuration and
// the course did not switch it off. New routes, not a field of an existing
// route: a new member of an existing route is a major release of
// @ductura/contracts (scripts/release/README.md, QA #92). Access comes only
// from the relation (C-23). Database: app.course_assistant_switch,
// app.course_assistant_switch_read, app.my_assistant_available (20261219440000).

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const CourseParams = closed({ courseId: Uuid });
const Switch = closed({ enabled: Type.Boolean() });
const Availability = closed({ assistantEnabled: Type.Boolean() });
const COURSE_INVENTORY = "app/api/teacher/courses/[courseId]/assistant/route.ts";

const READ_ERRORS = [
  error(401, "unauthorized"),
  error(404, "not_found"),
  error(503, "unavailable"),
];

export const teacherCourseAssistantGet = defineRoute({
  id: "teacher.course-assistant.get",
  method: "GET",
  path: "/api/v1/teacher/courses/{courseId}/assistant",
  inventory: COURSE_INVENTORY,
  access: "course_teacher",
  summary:
    "A teacher of the course reads whether the assistant is switched on for the course, on by default. A student, a teacher of another course, an unknown or a malformed course returns 404.",
  request: { params: CourseParams },
  responses: [{ status: 200, description: "the state of the course's switch", body: Switch }],
  errors: READ_ERRORS,
});

export const teacherCourseAssistantPut = defineRoute({
  id: "teacher.course-assistant.put",
  method: "PUT",
  path: "/api/v1/teacher/courses/{courseId}/assistant",
  inventory: COURSE_INVENTORY,
  access: "course_teacher",
  summary:
    "Only a teacher of the course switches the assistant off or on for every assignment of the course, exactly {enabled}. Answers 200 with the state in force; setting the state in force changes nothing. Every change is recorded in the audit trail in the same transaction. A body that is not exactly this is 422. A student, a teacher of another course, an unknown or a malformed course returns 404.",
  request: {
    params: CourseParams,
    contentType: "application/json",
    maxBodyBytes: 256,
    body: Switch,
  },
  responses: [{ status: 200, description: "the state in force", body: Switch }],
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

export const studentAssignmentAssistantGet = defineRoute({
  id: "student.assignment-assistant.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/assistant",
  inventory: "app/api/student/assignments/[assignmentId]/assistant/route.ts",
  access: "student_enrolled",
  summary:
    "Whether the assistant is available for the assignment, for a student of its course: true exactly when the server has a provider, the institution has a published cost configuration and the course did not switch the assistant off. The assignment's own rules still decide what the assistant may do. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [{ status: 200, description: "the availability", body: Availability }],
  errors: READ_ERRORS,
});

export const courseAssistantRoutes = [
  teacherCourseAssistantGet,
  teacherCourseAssistantPut,
  studentAssignmentAssistantGet,
] as const;
