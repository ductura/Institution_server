import { pinsOf } from "./assignment-template-routes.ts";
import type { Handlers } from "./server.ts";

// SRV-V17-FORMAT-RULES: the format rules of an assignment on the dev fake server, composed as
// the real route does: the word range of the assignment, the skeleton frozen on it (none: no
// sections, fpzg), minSources 0 and the rules-package fields null (Q-11).
export const FORMAT_RULES_HANDLERS: Handlers = {
  "student.assignment-format-rules.get": ({ state, account, params, query }) => {
    if (account === null) return { error: "unauthorized" };
    if (Object.keys(query).length > 0) return { error: "invalid_input" };
    const assignment = state.assignments.find((a) => a.id === params.assignmentId.toLowerCase());
    const course = state.courses.find((c) => c.id === assignment?.courseId);
    if (assignment === undefined || !course?.studentIds.includes(account.id)) {
      return { error: "not_found" };
    }
    const frozen = pinsOf(state).get(assignment.id);
    return {
      status: 200,
      body: {
        wordMin: assignment.content.wordMin,
        wordMax: assignment.content.wordMax,
        minSources: 0,
        requiredSections: frozen?.sections.map((section) => section.title) ?? [],
        citationStyle: "fpzg",
        font: null,
        size: null,
        spacing: null,
      },
    };
  },
};
