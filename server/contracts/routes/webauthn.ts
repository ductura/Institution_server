import { Type } from "@sinclair/typebox";

import { closed, defineRoute, error } from "../schema/index.ts";

import { MUTATION_GUARD } from "./shared.ts";

// S-1E-g (DAN-840-1): WebAuthn as the second factor of operators. Never a way
// to sign in (D-09; Ductus D-297): every route needs an AAI@EduHr session.
// ES256 only, attestation "none": registration sends getAuthenticatorData()
// and the server keeps the COSE key it carries (identity.webauthn_credential),
// so no attestation object is read. Who may hold a second factor and what a
// confirmation unlocks is S-1J.2 (DAN-842).

/**
 * Unpadded base64url of 1 to `max` characters. `(?![\s\S])` and not `$`, so no
 * reader of the OpenAPI document lets a trailing newline through.
 */
const base64url = (max: number) =>
  Type.String({ maxLength: max, pattern: "^[A-Za-z0-9_-]+(?![\\s\\S])" });

/** Refusals of a ceremony; unknown, used and expired challenges are not told apart. */
const CEREMONY_ERRORS = [error(400, "challenge_invalid"), error(400, "ceremony_invalid")] as const;

const BODY_ERRORS = [
  ...MUTATION_GUARD,
  error(401, "unauthorized"),
  error(415, "unsupported_media_type"),
  error(400, "invalid_json"),
  error(422, "invalid_input"),
  error(503, "unavailable"),
] as const;

/** Fields of every challenge; the browser asks for ES256 and user presence. */
const CHALLENGE = {
  challenge: Type.String({ pattern: "^[A-Za-z0-9_-]{43}(?![\\s\\S])" }),
  rpId: Type.String({ minLength: 1, maxLength: 253 }),
  timeoutMs: Type.Integer({ minimum: 1, maximum: 600_000 }),
};

export const webauthnChallengePost = defineRoute({
  id: "auth.webauthn-challenge.post",
  method: "POST",
  path: "/api/v1/auth/webauthn/challenge",
  inventory: "app/api/auth/webauthn/challenge/route.ts",
  access: "signed_in",
  summary:
    "A one-time challenge of 32 random bytes for one ceremony of this session, registration or assertion. It expires after timeoutMs and is spent by the first attempt, successful or not.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 256,
    body: closed({
      purpose: Type.Union([Type.Literal("registration"), Type.Literal("assertion")]),
    }),
  },
  responses: [
    {
      status: 200,
      description: "challenge issued; the purpose picks the shape",
      body: Type.Union([
        closed({
          ...CHALLENGE,
          purpose: Type.Literal("registration"),
          // user.id of create(): random bytes, never a name or an id of the account.
          userHandle: Type.String({ pattern: "^[A-Za-z0-9_-]{22}(?![\\s\\S])" }),
        }),
        closed({
          ...CHALLENGE,
          purpose: Type.Literal("assertion"),
          // allowCredentials of get(): the caller's keys that are not revoked.
          allowCredentials: Type.Array(base64url(1364), { maxItems: 16 }),
        }),
      ]),
    },
  ],
  errors: BODY_ERRORS,
});

export const webauthnRegistrationPost = defineRoute({
  id: "auth.webauthn-registration.post",
  method: "POST",
  path: "/api/v1/auth/webauthn/registration",
  inventory: "app/api/auth/webauthn/registration/route.ts",
  access: "signed_in",
  summary:
    "Registers the caller's security key (ES256, COSE -7; attestation none) against a registration challenge; the key is the COSE key in authenticatorData. 403 when the account already has a key, 409 when the key is registered.",
  request: {
    contentType: "application/json",
    maxBodyBytes: 8 * 1024,
    body: closed({
      // Carries the credential id and the COSE key; credentialId must be the same id.
      authenticatorData: base64url(2048),
      clientDataJSON: base64url(2048),
      credentialId: base64url(1364),
    }),
  },
  responses: [{ status: 204, description: "registered" }],
  errors: [...BODY_ERRORS, ...CEREMONY_ERRORS, error(403, "forbidden"), error(409, "conflict")],
});

export const webauthnAssertionPost = defineRoute({
  id: "auth.webauthn-assertion.post",
  method: "POST",
  path: "/api/v1/auth/webauthn/assertion",
  inventory: "app/api/auth/webauthn/assertion/route.ts",
  access: "signed_in",
  summary:
    "Confirms the caller's security key against an assertion challenge. 403 for a key that is not the caller's or is revoked; 409 when the signature counter fell or stayed the same (0 to 0 is accepted).",
  request: {
    contentType: "application/json",
    maxBodyBytes: 8 * 1024,
    body: closed({
      authenticatorData: base64url(1024),
      clientDataJSON: base64url(2048),
      credentialId: base64url(1364),
      signature: base64url(128),
    }),
  },
  responses: [{ status: 204, description: "confirmed" }],
  errors: [
    ...BODY_ERRORS,
    ...CEREMONY_ERRORS,
    error(403, "forbidden"),
    error(409, "counter_not_increased"),
  ],
});

export const webauthnRoutes = [
  webauthnChallengePost,
  webauthnRegistrationPost,
  webauthnAssertionPost,
] as const;
