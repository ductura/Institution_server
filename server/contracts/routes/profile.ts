import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error, v1Error } from "../schema/index.ts";

const Locale = Type.Union([Type.Literal("hr"), Type.Literal("en")]);

// Shared refusals of the mutation guard and body reader (Origin, type, size, time).
// 403 and 400 have several errors each (a oneOf), so they keep the v1 body.
const MUTATION_ERRORS = [
  v1Error(403, "origin_missing"),
  v1Error(403, "origin_mismatch"),
  v1Error(403, "cross_site"),
  error(415, "unsupported_media_type"),
  error(413, "body_too_large"),
  error(408, "body_timeout"),
  v1Error(400, "content_length_invalid"),
  v1Error(400, "content_length_mismatch"),
  v1Error(400, "body_stream_error"),
  v1Error(400, "invalid_json"),
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

export const profileRoutes = [interfaceLocaleGet, interfaceLocalePost] as const;
