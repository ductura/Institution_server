import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

const ComponentState = Type.Union([
  Type.Literal("radi"),
  Type.Literal("ne_radi"),
  Type.Literal("nije_ukljuceno"),
]);
const UtcInstant = Type.String({
  format: "date-time",
  pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$",
});

export const status = defineRoute({
  id: "platform.status.get",
  method: "GET",
  path: "/api/v1/status",
  inventory: "app/api/status/route.ts",
  access: "anyone",
  summary: "Public status in three parts, closed words, nothing about a person.",
  request: {},
  responses: [
    {
      status: 200,
      description: "status",
      body: closed({
        checkedAt: Type.String({ format: "date-time", maxLength: 24 }),
        components: closed({
          writing: ComponentState,
          submission: ComponentState,
          mentorView: ComponentState,
        }),
        maintenanceWindows: Type.Optional(
          Type.Array(closed({ startsAt: UtcInstant, endsAt: UtcInstant }), {
            maxItems: 50,
            description:
              "Current and upcoming planned maintenance, ordered by start time. Omitted when the schedule could not be read.",
          }),
        ),
      }),
    },
  ],
  errors: [error(503, "unavailable", "none")],
});
