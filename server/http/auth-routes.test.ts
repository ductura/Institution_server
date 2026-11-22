// Ported from Ductus tests/unit/auth/routes.test.ts (OSN-T1). D-09: AAI@EduHr
// is the only login, so the auth API is exactly this set of routes; another
// (a password form, a magic link, another provider) fails here and needs a
// decision first. Back-channel logout and sign-out on every device only close
// sessions, never open one. The WebAuthn routes are the second factor of an
// already signed-in AAI@EduHr identity, not a login. The old app/ directory
// walk is replaced by the contract, which now declares every mounted route.
import { describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";

describe("auth route inventory", () => {
  it("has login, callback, logout, logout-all, back-channel logout and WebAuthn under /api/v1/auth and nothing else", () => {
    const ids = ROUTES.filter((r) => r.path.startsWith("/api/v1/auth/"))
      .map((r) => `${r.method} ${r.path}`)
      .sort();
    expect(ids).toEqual(
      [
        "GET /api/v1/auth/callback",
        "GET /api/v1/auth/login",
        "POST /api/v1/auth/backchannel-logout",
        "POST /api/v1/auth/logout",
        "POST /api/v1/auth/logout-all",
        "POST /api/v1/auth/webauthn/assertion",
        "POST /api/v1/auth/webauthn/challenge",
        "POST /api/v1/auth/webauthn/registration",
      ].sort(),
    );
  });

  it("has no other route that names a login, session or password", () => {
    const suspicious = ROUTES.filter(
      (r) =>
        !r.path.startsWith("/api/v1/auth/") &&
        /(log-?in|sign-?in|passw|oauth|oidc|saml)/i.test(r.path),
    ).map((r) => r.path);
    expect(suspicious).toEqual([]);
  });
});

// The old second block (the fake provider in a production build ends on the
// 503 page; back-channel logout answers 503 and 405 to GET) is covered end to
// end by auth.integration.test.ts ("D-09: the fake provider with NODE_ENV %s")
// and auth-backchannel.integration.test.ts.
