import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// SRV-V17-FORMAT-RULES (val 17, provjera oblika): the format rules a student's work is checked
// against before submission, for one assignment. They are read, never stored: the word range is
// the current version of the assignment (student.assignment-requirements.get), the required
// sections and the citation style are the skeleton frozen on the assignment
// (student.assignment-template.get, SRV-V17-TEMPLATE-ASSIGN). The check itself is advisory and
// runs in the client; it never blocks a submission.
//
// Fields no source gives yet are explicit: minSources is 0 (the assignment has no such field,
// so no minimum), and font, size and spacing are null until the Lekta package is available
// (Q-11). No new table and no migration.

/** The longest skeleton a template carries (the same bound as the work template). */
export const FORMAT_RULES_MAX_SECTIONS = 30;

const Count = Type.Integer({ minimum: 1, maximum: 1_000_000 });

export const FormatRules = closed({
  /** The lower word bound of the assignment; null leaves the end open. */
  wordMin: Type.Union([Count, Type.Null()]),
  /** The upper word bound of the assignment; null leaves the end open. */
  wordMax: Type.Union([Count, Type.Null()]),
  /** The fewest sources the work must cite; 0 when the assignment sets no minimum. */
  minSources: Type.Integer({ minimum: 0, maximum: 1000 }),
  /** The titles of the sections the work must have, in order; empty without a template. */
  requiredSections: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), {
    maxItems: FORMAT_RULES_MAX_SECTIONS,
  }),
  citationStyle: Type.Literal("fpzg"),
  /** The font family of the rules package; null while it is not available (Q-11). */
  font: Type.Union([Type.String({ minLength: 1, maxLength: 80 }), Type.Null()]),
  /** The font size in points; null while the rules package is not available (Q-11). */
  size: Type.Union([Type.Number({ minimum: 6, maximum: 72 }), Type.Null()]),
  /** The line spacing as a multiple of the line; null while the rules package is not available. */
  spacing: Type.Union([Type.Number({ minimum: 1, maximum: 3 }), Type.Null()]),
});
export type FormatRules = Static<typeof FormatRules>;

export const studentAssignmentFormatRulesGet = defineRoute({
  id: "student.assignment-format-rules.get",
  method: "GET",
  path: "/api/v1/student/assignments/{assignmentId}/format-rules",
  inventory: "app/api/student/assignments/[assignmentId]/format-rules/route.ts",
  access: "student_enrolled",
  summary:
    "The format rules the work on this assignment is checked against before submission: {wordMin, wordMax, minSources, requiredSections, citationStyle, font, size, spacing}. wordMin and wordMax are the word range of the current assignment version (null leaves that end open); requiredSections are the section titles of the template frozen on the assignment, in order, and empty when it uses none; citationStyle is the style of the template, fpzg without one; minSources is 0 because the assignment sets no minimum; font, size and spacing are null until the rules package is available. No query. The check built on these rules is advisory and never blocks a submission. An assignment of a course the caller is not a student of, a mentorship assignment, an unknown and a malformed id are the same 404 (C-23).",
  request: {
    params: closed({ assignmentId: Type.String({ minLength: 1 }) }),
    query: Type.Object({}, { maxProperties: 0 }),
  },
  responses: [
    {
      status: 200,
      description: "the format rules",
      body: FormatRules,
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const formatRulesRoutes = [studentAssignmentFormatRulesGet] as const;
