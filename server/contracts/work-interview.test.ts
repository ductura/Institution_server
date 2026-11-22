import { describe, expect, it } from "vitest";

import { workInterviewRoutes } from "./routes/index.ts";

// SRV-1530 (N-14): the interview is a preparation, not a proceeding. No schema
// of its routes carries a field for an outcome, a grade, a sanction or a
// suspicion, in English or in Croatian.
const FORBIDDEN =
  /outcome|grade|score|sanction|suspicion|verdict|ishod|ocjen|bod|sankcij|sumnj|kazn|presud/iu;

function propertyNames(schema: unknown, found: string[] = []): string[] {
  if (schema === null || typeof schema !== "object") return found;
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value !== null && typeof value === "object") {
      found.push(...Object.keys(value));
    }
    propertyNames(value, found);
  }
  return found;
}

describe("work interview contracts", () => {
  it("name the seven routes of the preparation", () => {
    expect(workInterviewRoutes.map((route) => route.id)).toEqual([
      "work.interview.get",
      "work.interview-questions.post",
      "work.interview-questions.delete",
      "work.interview-invite.post",
      "work.interview-appointment.put",
      "work.interview-held.post",
      "work.interview-explanations.post",
    ]);
  });

  it("have no field for an outcome, a grade, a sanction or a suspicion", () => {
    const names = workInterviewRoutes.flatMap((route) => [
      ...propertyNames(route.request),
      ...propertyNames(route.responses),
    ]);
    expect(names.length).toBeGreaterThan(10);
    expect(names.filter((name) => FORBIDDEN.test(name))).toEqual([]);
  });
});
