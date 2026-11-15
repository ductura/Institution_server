// D-09: students sign in with AAI@EduHr alone. The fake provider exists for
// local development and CI, so it refuses to start anywhere else. An allow
// list: an unset NODE_ENV and the two local values start it; production in any
// spelling, and any value nobody listed here, stop it before it listens.
const ALLOWED_NODE_ENV = new Set(["", "development", "test"]);

/** Throws unless NODE_ENV says local development or test. */
export function assertFakeOidcAllowed(env: { readonly NODE_ENV?: string | undefined }): void {
  const value = env.NODE_ENV ?? "";
  if (!ALLOWED_NODE_ENV.has(value)) {
    throw new Error(
      `fake OIDC runs only locally and in CI (NODE_ENV unset, development or test), not with NODE_ENV=${JSON.stringify(value)}`,
    );
  }
}
