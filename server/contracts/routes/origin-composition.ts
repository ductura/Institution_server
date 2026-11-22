import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkId } from "./collaboration.ts";

// SRV-0910 (Ductus#2052; P-1, rules 1 and 8, C-6): the composition of a work by
// the kind of origin of its changes, as a share per kind of a closed list. The
// answer is the same for the student who owns the work and for its readers
// (the teacher of the course, the teacher of the seminar group, the mentor): it
// has no parameter that could make two answers differ. It holds shares of
// characters per kind and nothing else: no key, no speed, no average, no
// profile, no comparison. A share says where text came from, never who wrote it
// (the client shows "Ovo nije dokaz autorstva" beside it). Database:
// app.work_origin_composition (20261213100300).

/** The closed list of the kinds of origin, in the order of the answer. */
export const ORIGIN_KINDS = [
  "typed",
  "assistant_inserted",
  "assistant_match",
  "imported_file",
  "pasted_known",
  "pasted_unknown",
] as const;
export type OriginKind = (typeof ORIGIN_KINDS)[number];

const Part = closed({
  kind: Type.Union(ORIGIN_KINDS.map((kind) => Type.Literal(kind))),
  /** Share of the characters of the work, 0 to 100, one decimal. */
  percent: Type.Number({ minimum: 0, maximum: 100 }),
});

export const originCompositionGet = defineRoute({
  id: "work.origin-composition.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/origin-composition",
  inventory: "app/api/works/[documentId]/origin-composition/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The share of the characters of a work per kind of origin (typed, assistant_inserted, assistant_match, imported_file, pasted_known, pasted_unknown), always all six in this order, all 0 while nothing is recorded. The same answer for the student who owns the work and for its readers. It is a record of where text came from, not of who wrote it. Another's, an unknown or a malformed work returns 404.",
  request: { params: closed({ documentId: WorkId }) },
  responses: [
    {
      status: 200,
      description: "the share per kind",
      body: closed({ parts: Type.Array(Part, { minItems: 6, maxItems: 6 }) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(404, "not_found"), error(503, "unavailable")],
});

export const originCompositionRoutes = [originCompositionGet] as const;
