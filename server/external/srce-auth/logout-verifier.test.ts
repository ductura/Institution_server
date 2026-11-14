import { describe, expect, it } from "vitest";

import { loadAuthConfig } from "./config.ts";
import { createCachedKeySource } from "./logout-keys.ts";
import { BACKCHANNEL_LOGOUT_EVENT } from "./logout-token.ts";
import { createLogoutVerifier } from "./logout-verifier.ts";
import { createOidcClient } from "./oidc.ts";

import {
  CLIENT_ID,
  CLIENT_SECRET,
  createTestIdp,
  ISSUER,
} from "../../../test-support/test-idp/index.ts";

// DAN-474: the logout verifier port the back-channel route receives
// (attack plan #1620: A1, A5, E4, G3, G4). Real openid-client discovery and
// JWKS against the in-process provider, composed as the composer does it;
// the route's own answers are in server/session/backchannel.test.ts.
// Every identifier is invented.
const APP = "https://ductus.test";
const config = loadAuthConfig({
  NODE_ENV: "test",
  DUCTUS_AUTH_PROVIDER: "fake-oidc",
  OIDC_ISSUER: ISSUER,
  OIDC_CLIENT_ID: CLIENT_ID,
  OIDC_CLIENT_SECRET: CLIENT_SECRET,
  OIDC_REDIRECT_URI: `${APP}/api/auth/callback`,
});
const SUB = "sub-demo-bc";
const SID = "sid-demo-bc-1";
const JTI = "jti-demo-bc-1";

function claims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: Math.floor(Date.now() / 1000),
    jti: JTI,
    sub: SUB,
    sid: SID,
    events: { [BACKCHANNEL_LOGOUT_EVENT]: {} },
    ...overrides,
  };
}

function setup() {
  const idp = createTestIdp();
  const oidc = createOidcClient(config, idp.fetch);
  const verifier = createLogoutVerifier({
    config,
    discoveredIssuer: () => oidc.discoveredIssuer(),
    keys: createCachedKeySource({ load: () => oidc.jwks() }),
  });
  return { idp, verifier };
}

describe("createLogoutVerifier", () => {
  it("A1: accepts a token the provider signed and names the account issuer", async () => {
    const { idp, verifier } = setup();
    expect(await verifier.verify(idp.logoutToken(claims()))).toEqual({
      ok: true,
      sub: SUB,
      sid: SID,
      jti: JTI,
    });
    expect(verifier.accountIssuer).toBe(ISSUER);
  });

  it("A5: reports a token the provider did not sign as invalid", async () => {
    const { idp, verifier } = setup();
    idp.state.next = { signing: "foreign-key" };
    const result = await verifier.verify(idp.logoutToken(claims()));
    expect(result).toMatchObject({ ok: false, reason: "invalid" });
  });

  it("E4: reports a wrong audience as invalid with a code only", async () => {
    const { idp, verifier } = setup();
    const result = await verifier.verify(idp.logoutToken(claims({ aud: "someone-else" })));
    expect(result).toEqual({ ok: false, reason: "invalid", code: "audience" });
  });

  it("G3: reports unavailable provider keys as unavailable, not invalid", async () => {
    const { idp, verifier } = setup();
    idp.state.next = { down: true };
    const result = await verifier.verify("e30.e30.c2ln");
    expect(result).toMatchObject({ ok: false, reason: "unavailable" });
  });

  it("G4: tokens with unknown kids do not make it fetch the JWKS each time", async () => {
    const { idp, verifier } = setup();
    idp.state.next = { signing: "unknown-kid" };
    for (let i = 0; i < 5; i++) {
      expect(await verifier.verify(idp.logoutToken(claims()))).toMatchObject({
        ok: false,
        reason: "invalid",
      });
    }
    expect(idp.requests.filter((path) => path === "/jwks").length).toBeLessThanOrEqual(1);
  });
});
