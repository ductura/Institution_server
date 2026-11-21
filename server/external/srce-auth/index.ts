// Public interface of the AAI@EduHr OIDC client (D-09). Other areas import
// from here, never from the files next to it. Ported from Ductus
// src/server/auth at d52a92c3 (S-0.18, DAN-731).
export {
  STAFF_AFFILIATION_MISSING,
  STAFF_AFFILIATION_SOURCES,
  STAFF_EDU_PERSON_VALUES,
  staffAffiliationFromClaims,
  type StaffAffiliation,
  type StaffAffiliationSource,
} from "./affiliation.ts";
export {
  identityFromClaims,
  TEACHER_AFFILIATIONS,
  type ClaimsResult,
  type LoginIdentity,
} from "./claims.ts";
export {
  AuthConfigError,
  expectedOrigin,
  isNonProductionBuild,
  loadAuthConfig,
  type AuthConfig,
  type AuthProvider,
  type IdTokenAlg,
} from "./config.ts";
export {
  createCachedKeySource,
  JWKS_MAX_AGE_SECONDS,
  JWKS_MIN_REFRESH_SECONDS,
  selectKey,
  type CachedKeySourceOptions,
} from "./logout-keys.ts";
export {
  BACKCHANNEL_LOGOUT_EVENT,
  LogoutTokenError,
  MAX_LOGOUT_TOKEN_CHARS,
  MAX_TOKEN_AGE_SECONDS,
  verifyLogoutToken,
  type LogoutKeySource,
  type LogoutTokenChecks,
  type LogoutTokenErrorCode,
  type VerifiedLogoutToken,
} from "./logout-token.ts";
export {
  createLogoutVerifier,
  type LogoutVerification,
  type LogoutVerifier,
  type LogoutVerifierOptions,
} from "./logout-verifier.ts";
export {
  accountIssuer,
  createOidcClient,
  isProviderUnavailable,
  issuedWithinSkew,
  limitedFetch,
  MAX_PROVIDER_RESPONSE_BYTES,
  newLoginChecks,
  PROVIDER_TIMEOUT_SECONDS,
  ProviderUnavailableError,
  SCOPES,
  type LoginChecks,
  type LogoutProvider,
  type OidcClient,
  type VerifiedLogin,
} from "./oidc.ts";
