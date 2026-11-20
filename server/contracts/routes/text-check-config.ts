import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-1101 (Ductus#2028, Val 11, C-12): the text checks of the editor and the
// Lekta profile of the institution of an accessible assignment. The identifiers
// are those of the editor prototype; this package imports nothing from the
// server, so the test in server/http/text-check-config keeps them equal to
// server/domain/settings/text-check-rules.ts. No work content is in the answer.

export const studentTextCheckConfigGet = defineRoute({
  id: "student.text-check-config.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/text-check-config",
  inventory: "app/api/student/assignments/[assignmentId]/text-check-config/route.ts",
  access: "student_enrolled",
  summary:
    "The text checks the caller's institution turns on (enabledCheckIds, in the order of the prototype) and its Lekta profile (lektaProfileId, null when the institution has set none). The answer holds no content of any work. An inaccessible, unknown or malformed assignment id returns 404.",
  request: { params: closed({ assignmentId: Type.String({ minLength: 1 }) }) },
  responses: [
    {
      status: 200,
      description: "the configuration of the institution",
      body: closed({
        enabledCheckIds: Type.Array(Type.String({ minLength: 1, maxLength: 32 }), {
          maxItems: 32,
        }),
        lektaProfileId: Type.Union([Type.String({ minLength: 1, maxLength: 128 }), Type.Null()]),
      }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const textCheckConfigRoutes = [studentTextCheckConfigGet] as const;
