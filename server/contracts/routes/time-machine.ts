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
const DiffBlock = Type.Union([
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

export const workVersionGet = defineRoute({
  id: "work.version.get",
  method: "GET",
  path: "/api/v1/works/{documentId}/versions/{revision}",
  inventory: "app/api/works/[documentId]/versions/[revision]/route.ts",
  access: "owner_or_mentor",
  summary:
    "Reads one verified revision of the work from its checkpoint. The owner can read saved revisions; the active mentor can read only versions sent for review or submitted. With compareFrom set to an earlier revision, returns the wave 9 block diff of two sent revisions. Missing or inaccessible work or revision returns 404.",
  request: {
    params: closed({ documentId: WorkId, revision: RevisionText }),
    query: closed({ compareFrom: Type.Optional(RevisionText) }),
  },
  responses: [
    {
      status: 200,
      description: "a verified revision or the difference between two sent revisions",
      body: Type.Union([
        closed({
          revision: Revision,
          document: Type.String({
            minLength: 1,
            maxLength: 2_097_152,
            description: "Canonical JSON of the document.",
          }),
        }),
        closed({
          from: Revision,
          to: Revision,
          blocks: Type.Array(DiffBlock, { maxItems: 10_000 }),
        }),
      ]),
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});
