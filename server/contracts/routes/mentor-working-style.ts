// F4-MEN-R09-SRV (Ductus#2058, orchestrator decision of 26. 11. 2026): "Kako
// mentor radi". A free text of at most 1000 characters that the mentor writes
// about the own way of working; a student with a mentorship in force reads it.
// Two new routes, nothing existing changes. Identity and institution are never
// in the request.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";
import { CODE_POINT, END } from "./teacher.ts";

/** The longest text, in characters; the database holds it to the same bound. */
export const MENTOR_WORKING_STYLE_MAX = 1000;

export const MentorWorkingStyleParams = closed({
  teacherId: Type.String({
    pattern: `^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}${END}`,
  }),
});
const Text = Type.String({
  pattern: `^(?=[\\s\\S]*[^ \\t\\r\\n])(?:${CODE_POINT}|[^\\u0000\\uD800-\\uDFFF]){1,${MENTOR_WORKING_STYLE_MAX}}${END}`,
});
export const MentorWorkingStyleInput = closed({ text: Text });
const Instant = Type.String({
  pattern: `^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z${END}`,
});

export const mentorWorkingStylePut = defineRoute({
  id: "mentorship.working-style.put",
  method: "PUT",
  path: "/api/v1/teacher/mentor-working-style",
  inventory: "app/api/teacher/mentor-working-style/route.ts",
  access: "teacher",
  summary:
    "The mentor writes or replaces the own working-style text: exactly {text}, 1 to 1000 characters, not only white space. One text per mentor; the answer is the stored text and its instant. Only a teacher with a confirmed role; anyone else is 403.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 8192,
    body: MentorWorkingStyleInput,
  },
  responses: [
    {
      status: 200,
      description: "the stored text",
      body: closed({ text: Text, updatedAt: Instant }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const mentorWorkingStyleGet = defineRoute({
  id: "mentorship.working-style.get",
  method: "GET",
  path: "/api/v1/student/mentors/{teacherId}/working-style",
  inventory: "app/api/student/mentors/[teacherId]/working-style/route.ts",
  access: "student",
  summary:
    "The working-style text of a mentor the caller has a mentorship in force with: {text, updatedAt}, both null while the mentor wrote none. Anyone without such a mentorship, a teacher, an unknown mentor and a malformed id all read the same 404; a request from another site is 403. The read writes nothing in the access log.",
  request: { params: MentorWorkingStyleParams },
  responses: [
    {
      status: 200,
      description: "the text, or nulls",
      body: Type.Union([
        closed({ text: Text, updatedAt: Instant }),
        closed({ text: Type.Null(), updatedAt: Type.Null() }),
      ]),
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(404, "not_found"),
    error(503, "unavailable"),
  ],
});

export const mentorWorkingStyleRoutes = [mentorWorkingStyleGet, mentorWorkingStylePut] as const;
