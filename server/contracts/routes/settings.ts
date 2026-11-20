import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

// Settings by level (S-1J-f, DAN-806; D-298, D-297; contract on Ductus#1836
// c.6906291102). The handlers are part of S-1J-g and SRV-7E. The database
// decides who writes which level (settings.set_value, DAN-801); `access` declares that a session is
// needed. The catalogue itself is server/domain/settings; this package
// imports nothing from it, so tests/contracts/settings-catalogue.test.ts
// holds the vector of settings.catalogue.get equal to it.

const Uuid = Type.String({
  pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
});
const Level = Type.Union(
  ["personal", "course", "institution", "system", "network_security"].map((level) =>
    Type.Literal(level),
  ),
);
// The key check of settings.value.key; the catalogue decides which keys exist.
const Key = Type.String({ maxLength: 64, pattern: "^[a-z][a-z0-9_]*(\\.[a-z][a-z0-9_]*)*$" });
const Value = Type.Union([Type.Boolean(), Type.Integer(), Type.String({ maxLength: 256 })]);
const Bound = Type.Union([
  closed({ locked: Type.Literal(true) }),
  Type.Object(
    { min: Type.Optional(Type.Integer()), max: Type.Optional(Type.Integer()) },
    { additionalProperties: false, minProperties: 1 },
  ),
]);
/** ISO 8601 UTC, as Date.toISOString. */
const Instant = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" });

const Definition = closed({
  key: Key,
  levels: Type.Array(Level, { minItems: 1 }),
  kind: Type.Union([Type.Literal("boolean"), Type.Literal("integer"), Type.Literal("enum")]),
  default: Value,
  min: Type.Optional(Type.Integer()),
  max: Type.Optional(Type.Integer()),
  values: Type.Optional(Type.Array(Type.String({ maxLength: 256 }), { minItems: 1 })),
});

// The refusals of the mutation guard and body reader, as profile.ts; under
// 403 and 400 a oneOf discriminated by the code (DAN-791).
const MUTATION_ERRORS = [
  error(403, "origin_missing"),
  error(403, "origin_mismatch"),
  error(403, "cross_site"),
  error(415, "unsupported_media_type"),
  error(413, "body_too_large"),
  error(408, "body_timeout"),
  error(400, "content_length_invalid"),
  error(400, "content_length_mismatch"),
  error(400, "body_stream_error"),
  error(400, "invalid_json"),
] as const;

export const settingsCatalogueGet = defineRoute({
  id: "settings.catalogue.get",
  method: "GET",
  path: "/api/v1/settings/catalogue",
  inventory: "app/api/settings/catalogue/route.ts",
  access: "signed_in",
  summary:
    "The settings catalogue: every key, the levels that may hold it, its kind, default and hard limits.",
  request: {},
  responses: [
    { status: 200, description: "catalogue", body: closed({ keys: Type.Array(Definition) }) },
  ],
  errors: [error(401, "unauthorized"), error(503, "unavailable")],
});

export const settingsValuesGet = defineRoute({
  id: "settings.values.get",
  method: "GET",
  path: "/api/v1/settings/values",
  inventory: "app/api/settings/values/route.ts",
  access: "signed_in",
  summary:
    "The rows of one level in the caller's scope (course names the course for the course level and is absent for every other), and for every catalogue key of that level the value that holds without it (source: a higher level or default) and the narrowest higher bound. A level or course that is not the caller's gives 404, the same as a course that does not exist (C-23: another's is nonexistent).",
  request: {
    query: closed({ level: Level, course: Type.Optional(Uuid) }),
  },
  responses: [
    {
      status: 200,
      description: "the level's rows and what it inherits",
      body: closed({
        level: Level,
        course: Type.Union([Uuid, Type.Null()]),
        values: Type.Array(
          closed({
            key: Key,
            value: Type.Union([Value, Type.Null()]),
            bound: Type.Union([Bound, Type.Null()]),
            updatedAt: Instant,
          }),
        ),
        inherited: Type.Array(
          closed({
            key: Key,
            value: Value,
            source: Type.Union([Level, Type.Literal("default")]),
            bound: Type.Union([Bound, Type.Null()]),
          }),
        ),
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

export const settingsValuesPut = defineRoute({
  id: "settings.values.put",
  method: "PUT",
  path: "/api/v1/settings/values",
  inventory: "app/api/settings/values/route.ts",
  access: "signed_in",
  summary:
    "Sets the caller's value and bound of one key at one level (the bound as locked, min and max); no value and no bound remove the row and the level above holds again. course is a course id for the course level and null for every other. A level or course that is not the caller's gives 404, the same as a course that does not exist. A key outside the catalogue, a level the catalogue does not allow for it, a value of the wrong kind or out of its limits and a bound of a wrong shape give 422; crossing a higher bound gives 409. A refusal of the catalogue (422) comes before the level check (404), as in settings.set_value. 409 needs a key a lower level holds under a higher bound; the first catalogue has none, so its vector shows the shape only. Every change is kept with its author, time, old and new value.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 1024,
    // The bound is flat (locked, min, max): the ahead-of-time validators of
    // scripts/generate-contracts.ts read one level of fields. locked true
    // with min and max null is a lock; min and/or max is a range; all three
    // empty is no bound. Any other mix is 422.
    body: closed({
      level: Level,
      course: Type.Union([Uuid, Type.Null()]),
      key: Key,
      value: Type.Union([Value, Type.Null()]),
      locked: Type.Boolean(),
      min: Type.Union([Type.Integer(), Type.Null()]),
      max: Type.Union([Type.Integer(), Type.Null()]),
    }),
  },
  responses: [
    {
      status: 200,
      description: "saved (changed is false when the row already held it)",
      body: closed({
        key: Key,
        value: Type.Union([Value, Type.Null()]),
        bound: Type.Union([Bound, Type.Null()]),
        changed: Type.Boolean(),
      }),
    },
  ],
  errors: [
    ...MUTATION_ERRORS,
    error(401, "unauthorized"),
    error(404, "not_found"),
    error(409, "bound_crossed"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const settingsRoutes = [settingsCatalogueGet, settingsValuesGet, settingsValuesPut] as const;
