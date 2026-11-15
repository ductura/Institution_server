// Public interface of the software FIDO2 authenticator (U9).
import "../guard/index.ts";

export {
  createSoftwareAuthenticator,
  type Assertion,
  type AuthenticatorOptions,
  type Registration,
  type SoftwareAuthenticator,
} from "./authenticator.ts";
