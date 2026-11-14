// Public interface of the in-process OIDC test provider (tests only, D-09).
// Other folders import from here, never from the file next to it.
export {
  AAI_ATTRIBUTE_SCOPES,
  CLIENT_ID,
  CLIENT_SECRET,
  createTestIdp,
  ISSUER,
  type IdpShape,
  type Misbehaviour,
  type TestAccount,
} from "./test-idp.ts";
