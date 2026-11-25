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
//
// SRV-ASIST-BROJAC (Ductus#2055 T2, decision A): the daily number of requests a
// student of the assignment may send, as {limit, used}; a number of requests,
// never an amount (SRV-1809). A new route for the same reason. Over the limit,
// the request route answers its existing budget_exceeded. Database:
// app.my_assistant_requests (20261219450000).
//
// SRV-ASIST-LIMIT-ADMIN (Ductus#2055, approved 25. 11.): the administrator of an
// institution reads and sets that limit for the own institution, the value the
// operator sets with assistant.publish_request_limit. New routes for the same
// reason; no new error codes. Database: assistant.read_request_limit,
// assistant.set_request_limit (20261220100000).

const Uuid = Type.String({
  pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
});
const CourseParams = closed({ courseId: Uuid });
const Switch = closed({ enabled: Type.Boolean() });
const Availability = closed({ assistantEnabled: Type.Boolean() });
const MAX_INT = 2_147_483_647;
const Requests = closed({
  limit: Type.Union([Type.Integer({ minimum: 1, maximum: MAX_INT }), Type.Null()]),
  used: Type.Integer({ minimum: 0, maximum: MAX_INT }),
});
const RequestLimit = closed({
  version: Type.Integer({ minimum: 0, maximum: MAX_INT }),
  limit: Type.Union([Type.Integer({ minimum: 1, maximum: MAX_INT }), Type.Null()]),
});
const RequestLimitInput = closed({
  expectedVersion: Type.Integer({ minimum: 0, maximum: MAX_INT - 1 }),
  limit: Type.Union([Type.Integer({ minimum: 1, maximum: MAX_INT }), Type.Null()]),
});
const LIMIT_PATH = "/api/v1/institution/assistant/request-limit";
const LIMIT_INVENTORY = "app/api/institution/assistant/request-limit/route.ts";
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

export const studentAssignmentAssistantRequestsGet = defineRoute({
  id: "student.assignment-assistant-requests.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/assistant/requests",
  inventory: "app/api/student/assignments/[assignmentId]/assistant/requests/route.ts",
  access: "student_enrolled",
  summary:
    "How many assistant requests a student of the assignment may send today and has sent, as {limit, used}: limit is the daily number of requests per student and assignment the institution set, null when it set none; used counts today's requests (Europe/Zagreb) that were not refused. A number of requests, never an amount. Over the limit the request route answers budget_exceeded. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [{ status: 200, description: "the daily request count", body: Requests }],
  errors: READ_ERRORS,
});

export const institutionAssistantRequestLimitGet = defineRoute({
  id: "institution.assistant-request-limit.get",
  method: "GET",
  path: LIMIT_PATH,
  inventory: LIMIT_INVENTORY,
  access: "institution_admin",
  request: {},
  summary:
    "An administrator of the institution reads the daily number of assistant requests per student and assignment of the own institution, as {version, limit}: version is the latest version of the institution's cost configuration (0 when none), limit null when none is set. A number of requests, never an amount. A teacher, a student and an account without a confirmed role are 403.",
  responses: [{ status: 200, description: "the request limit in force", body: RequestLimit }],
  errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
});

export const institutionAssistantRequestLimitPut = defineRoute({
  id: "institution.assistant-request-limit.put",
  method: "PUT",
  path: LIMIT_PATH,
  inventory: LIMIT_INVENTORY,
  access: "institution_admin",
  summary:
    "Only an administrator of the institution sets the daily number of assistant requests per student and assignment of the own institution: exactly {expectedVersion, limit}, limit a positive integer or null to remove it. expectedVersion is the latest version the administrator saw (0 when none); another version added in between is 409 conflict, and the same change sent again returns the version it made. Every other value of the cost configuration stays. Answers 200 with {version, limit} in force. The new version is recorded in the audit trail in the same transaction. A body that is not exactly this is 422. A teacher, a student and an account without a confirmed role are 403. The institution and the author come from the session, never from the body.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 256,
    body: RequestLimitInput,
  },
  responses: [{ status: 200, description: "the request limit in force", body: RequestLimit }],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const courseAssistantRoutes = [
  teacherCourseAssistantGet,
  teacherCourseAssistantPut,
  studentAssignmentAssistantGet,
  studentAssignmentAssistantRequestsGet,
  institutionAssistantRequestLimitGet,
  institutionAssistantRequestLimitPut,
] as const;
