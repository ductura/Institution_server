import { assertFakeOidcAllowed } from "../oidc/index.ts";

// D-09: the package refuses to load outside local development and CI, with the
// allow list of the fake OIDC provider (oidc/guard.ts). Every entry point in
// package.json "exports" imports this or oidc/index.ts, which checks the same.
assertFakeOidcAllowed(process.env);
