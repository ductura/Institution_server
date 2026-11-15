// Public interface of the fake OIDC provider (local and CI only, D-09).
// Other folders import from here, never from the files next to it.
export {
  ACCOUNTS,
  DEMO_ACCOUNTS,
  DEMO_HOME_ORG,
  DEMO_HOME_ORG_B,
  demoAccountClaims,
  findDemoAccount,
  isDemoAccountId,
  type DemoAccount,
  type DemoAccountClaims,
} from "./accounts.ts";
export { assertFakeOidcAllowed } from "./guard.ts";
export { FAKE_OIDC_MODES, fakeOidcMode, type FakeOidcMode } from "./modes.ts";
export { DEFAULT_POST_LOGOUT_REDIRECT_URIS, DEFAULT_REDIRECT_URIS } from "./redirect-uris.ts";
export {
  createFakeOidc,
  fakeOidcConfigFromEnv,
  listenPort,
  type FakeOidcOptions,
} from "./server.ts";
