import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";
import { MUTATION_GUARD } from "./shared.ts";

const Text = Type.String({ minLength: 1, maxLength: 1000 });
const OptionalText = Type.Optional(Text);
const Source = closed({
  type: Type.Union([
    Type.Literal("book"),
    Type.Literal("chapter"),
    Type.Literal("article"),
    Type.Null(),
  ]),
  title: Text,
  authors: Type.Array(closed({ name: Text, family: OptionalText, given: OptionalText }), {
    maxItems: 50,
  }),
  year: Type.Optional(Type.Integer({ minimum: 1000, maximum: 9999 })),
  journal: OptionalText,
  bookTitle: OptionalText,
  publisher: OptionalText,
  place: OptionalText,
  volume: OptionalText,
  issue: OptionalText,
  pages: OptionalText,
});

export const sourceLookupPost = defineRoute({
  id: "sources.lookup.post",
  method: "POST",
  path: "/api/v1/sources/lookup",
  inventory: "app/api/sources/lookup/route.ts",
  access: "signed_in",
  summary:
    "Find bibliographic metadata for one DOI or ISBN in a catalogue, for synthetic students in local development.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 4096,
    body: closed({
      kind: Type.Union([Type.Literal("doi"), Type.Literal("isbn")]),
      identifier: Type.String({ minLength: 1, maxLength: 512 }),
    }),
  },
  responses: [
    {
      status: 200,
      description: "Metadata for the source, or null when the catalogue has no record.",
      body: closed({ source: Type.Union([Source, Type.Null()]) }),
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(400, "invalid_json"),
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(415, "unsupported_media_type"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
    error(503, "timeout"),
  ],
});
