// How the fake provider behaves, so the app's handling of each case can be
// tested (DAN-729). `success` is the provider as ported from Ductus.
// - refuse: the login ends with access_denied and no code.
// - expired: ID and access tokens live one second, so they expire at once.
// - unavailable: every request answers 503.
export const FAKE_OIDC_MODES = ["success", "refuse", "expired", "unavailable"] as const;

export type FakeOidcMode = (typeof FAKE_OIDC_MODES)[number];

function isFakeOidcMode(value: string): value is FakeOidcMode {
  return (FAKE_OIDC_MODES as readonly string[]).includes(value);
}

/** The mode from the environment; unset or empty is success, a typo stops the provider. */
export function fakeOidcMode(value: string | undefined): FakeOidcMode {
  if (value === undefined || value === "") return "success";
  if (!isFakeOidcMode(value)) throw new Error(`FAKE_OIDC_MODE must be one of ${FAKE_OIDC_MODES.join(", ")}: ${value}`);
  return value;
}
