// SRV-2004 (Faza 3, web and server aligned; Ductus#2052 c.7074315040): the
// comparison of two revisions of one work, over the server's own replay of the
// record (server/evidence/compare, SRV-9E). The answer is the block difference
// of work.version.get (the web's time-machine client shape): every block of both
// versions once as unchanged, removed or added, in order. The path revision
// parameters of work.version.get are query parameters here.
import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { WorkId } from "./versions.ts";

const Revision = Type.Integer({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER });
const RevisionText = Type.String({ pattern: "^[1-9][0-9]{0,15}(?![\\s\\S])" });
const Change = Type.Union([
  Type.Literal("unchanged"),
  Type.Literal("removed"),
  Type.Literal("added"),
]);
const CompareBlock = Type.Union([
  closed({
    kind: Type.Union([
      Type.Literal("paragraph"),
      Type.Literal("bulletItem"),
      Type.Literal("quote"),
    ]),
    change: Change,
    text: Type.String(),
  }),
  closed({
    kind: Type.Literal("heading"),
    level: Type.Integer({ minimum: 1, maximum: 3 }),
    change: Change,
    text: Type.String(),
  }),
]);

export const workCompareGet = defineRoute({
  id: "work.compare.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/compare",
  inventory: "app/api/works/[documentId]/compare/route.ts",
  access: "owner_or_course_teacher",
  summary:
    "The difference by blocks between revision from and revision to (from < to) of a work, rebuilt by the server from the verified record, not from saved texts: every block of both versions once as unchanged, removed or added, in order, at most 5000 blocks per version. The owner and a teacher of the work get the same answer; a teacher's read writes a row of the access log. A work or revision the caller may not read, or the record does not hold, returns 404; equal or reversed revisions and a missing or extra query parameter return 422; a record that cannot be replayed or a comparison too large returns 503.",
  request: {
    params: closed({ documentId: WorkId }),
    query: closed({ from: RevisionText, to: RevisionText }),
  },
  responses: [
    {
      status: 200,
      description: "the difference between the two revisions",
      body: closed({
        from: Revision,
        to: Revision,
        blocks: Type.Array(CompareBlock, { maxItems: 10_000 }),
      }),
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const workCompareRoutes = [workCompareGet] as const;
