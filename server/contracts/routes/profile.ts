import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

const Locale = Type.Union([Type.Literal("hr"), Type.Literal("en")]);

// Shared refusals of the mutation guard and body reader (Origin, type, size, time).
// 403 and 400 have several errors each: a oneOf discriminated by the code (DAN-791).
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

export const interfaceLocaleGet = defineRoute({
  id: "profile.interface-locale.get",
  method: "GET",
  path: "/api/v1/profile/interface-locale",
  inventory: "app/api/profile/interface-locale/route.ts",
  access: "signed_in",
  summary: "The caller's saved interface language, or null.",
  request: {},
  responses: [
    {
      status: 200,
      description: "saved value",
      body: closed({ locale: Type.Union([Locale, Type.Null()]) }),
    },
  ],
  errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
});

export const interfaceLocalePost = defineRoute({
  id: "profile.interface-locale.post",
  method: "POST",
  path: "/api/v1/profile/interface-locale",
  inventory: "app/api/profile/interface-locale/route.ts",
  access: "signed_in",
  summary: "Saves the caller's interface language. Canonical JSON, nothing but the locale.",
  request: { contentType: "application/json", maxBodyBytes: 256, body: closed({ locale: Locale }) },
  responses: [{ status: 200, description: "saved", body: closed({ locale: Locale }) }],
  errors: [
    ...MUTATION_ERRORS,
    error(401, "unauthorized"),
    error(422, "invalid_input"),
    error(503, "unavailable"),
  ],
});

const AccountRole = Type.Union([
  Type.Literal("student"),
  Type.Literal("teacher"),
  Type.Literal("network_engineer"),
  Type.Literal("institution_admin"),
]);

// The opaque name of the person's local journal (Ductus principal.scope):
// SHA-256 hex, lowercase, made by the server from internal ids only
// (Ductus#2028 c.7020997158, SRV-JS).
const JournalScope = Type.String({ pattern: "^[0-9a-f]{64}$" });

// The opaque tag of one login (Ductus#2028 c.7023897577, SRV-ST): HMAC-SHA-256
// hex, lowercase. Never the session id, the cookie, an e-mail or an AAI value.
const SessionTag = Type.String({ pattern: "^[0-9a-f]{64}$" });

// Contract Ductus#2028 c.6993786629 §3.3: the front of the institution reads
// the signed-in account after the AAI@EduHr login; 401 sends it to the login.
// journalScope names the person's local journal; the same for the same person
// and institution in every session, different for any other. sessionTag is
// the same within one session and different after every new login, for the
// same person too.
export const meGet = defineRoute({
  id: "profile.me.get",
  method: "GET",
  path: "/api/v1/me",
  inventory: "app/api/me/route.ts",
  access: "signed_in",
  summary: "The caller's institution, roles in force and display name.",
  request: {},
  responses: [
    {
      status: 200,
      description: "the signed-in account",
      body: closed({
        institution: closed({
          slug: Type.String(),
          displayName: Type.Union([Type.String(), Type.Null()]),
        }),
        roles: Type.Array(AccountRole, { minItems: 1 }),
        displayName: Type.Union([Type.String(), Type.Null()]),
        journalScope: JournalScope,
        sessionTag: SessionTag,
      }),
    },
  ],
  errors: [error(401, "unauthorized"), error(403, "forbidden"), error(503, "unavailable")],
});

export const profileRoutes = [interfaceLocaleGet, interfaceLocalePost, meGet] as const;
