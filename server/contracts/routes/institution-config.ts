import { Type, type Static } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// SRV-1406 (plan M2, institution administrator C1-C3): the versioned rules of
// the institution over SRV-1405 (app.institution_config,
// server/database/institution-config). Only an administrator of the
// institution reads or adds a version. A version is only ever added; the
// answer names the version, the moment it took effect and its rules (nested under rules).

/**
 * The `ductura-faculty-rules-v1` schema of SRV-1405, as the contract states it.
 * A duplicate language and a default that is not offered are refused by the
 * schema of the database port (422), not by this shape.
 */
export const InstitutionRules = closed({
  citationStyle: Type.Literal("fpzg"),
  workLanguages: Type.Array(Type.Union([Type.Literal("hr"), Type.Literal("en")]), {
    minItems: 1,
    maxItems: 2,
  }),
  defaultWorkLanguage: Type.Union([Type.Literal("hr"), Type.Literal("en")]),
});
export type InstitutionRules = Static<typeof InstitutionRules>;

/** One version: its number, when it took effect (Date.toISOString) and its rules. */
export const InstitutionConfigVersion = closed({
  version: Type.Integer({ minimum: 1, maximum: 2_147_483_647 }),
  effectiveFrom: Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$" }),
  rules: InstitutionRules,
});
export type InstitutionConfigVersion = Static<typeof InstitutionConfigVersion>;

/**
 * The rules sit beside expectedVersion, not under a key of their own: the
 * contract generator compiles one level of nested object and no array inside it.
 */
export const InstitutionConfigInput = closed({
  /** The latest version the administrator saw; 0 when there was none. */
  expectedVersion: Type.Integer({ minimum: 0, maximum: 2_147_483_646 }),
  ...InstitutionRules.properties,
});

export const institutionConfigGet = defineRoute({
  id: "institution.config.get",
  method: "GET",
  path: "/api/v1/institution/config",
  inventory: "app/api/institution/config/route.ts",
  access: "institution_admin",
  summary:
    "The rules of the caller's institution for an administrator of it: current is the latest version, or null while the institution has none, and versions is the whole history in ascending order of version. Each version is {version, effectiveFrom, rules}. No query. A teacher, a student and an account without a confirmed role in the institution are 403.",
  request: { query: Type.Object({}, { maxProperties: 0 }) },
  responses: [
    {
      status: 200,
      description: "the current version and the history",
      body: closed({
        current: Type.Union([InstitutionConfigVersion, Type.Null()]),
        versions: Type.Array(InstitutionConfigVersion),
      }),
      headers: ["cache-control"],
    },
  ],
  errors: [
    error(401, "unauthorized"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

export const institutionConfigVersionsPost = defineRoute({
  id: "institution.config-versions.post",
  method: "POST",
  path: "/api/v1/institution/config/versions",
  inventory: "app/api/institution/config/versions/route.ts",
  access: "institution_admin",
  summary:
    "An administrator of the institution adds the next version of its rules: exactly {expectedVersion, citationStyle, workLanguages, defaultWorkLanguage}, at most 4 KiB, sent as application/json. expectedVersion is the latest version the administrator saw (0 when none); another version added in between is 409 conflict. The rules are citationStyle: fpzg, workLanguages: a non-empty set of hr and en, and defaultWorkLanguage: one of workLanguages; anything else, including an unknown key and a default language that is not offered, is 422 invalid_input. A teacher, a student and an account without a confirmed role are 403. The institution and the author come from the session, never from the body. The new version is recorded in the audit trail in the same transaction. Success follows the database commit.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 4096,
    body: InstitutionConfigInput,
  },
  responses: [
    {
      status: 201,
      description: "the new version",
      body: InstitutionConfigVersion,
      headers: ["cache-control"],
    },
  ],
  errors: [
    ...MUTATION_GUARD,
    error(401, "unauthorized"),
    error(415, "unsupported_media_type"),
    error(400, "invalid_json"),
    error(403, "forbidden"),
    error(422, "invalid_input"),
    error(409, "conflict"),
    error(503, "unavailable"),
  ],
});

export const institutionConfigRoutes = [
  institutionConfigGet,
  institutionConfigVersionsPost,
] as const;
