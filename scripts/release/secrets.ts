// Strings that must never be in a published package. The fakes use generated
// keys at run time, so no published file carries key material.
const PATTERNS: readonly [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----/iu],
  ["private JWK", /"d"\s*:\s*"[A-Za-z0-9_-]{20,}"/u],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}/u],
  ["GitHub token", /\bgithub_pat_[A-Za-z0-9_]{22,}/u],
  ["npm token", /\bnpm_[A-Za-z0-9]{36,}/u],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["database URL with password", /\bpostgres(?:ql)?:\/\/[^\s/:@"']*:[^\s/@"']+@/iu],
  ["database URL with password", /\bpostgres(?:ql)?:\/\/\S*[?&]password=/iu],
];

export type SecretFinding = { readonly path: string; readonly kind: string };

/** Every file of `files` (path → text) that holds something like a secret. */
export function scanSecrets(files: Readonly<Record<string, string>>): SecretFinding[] {
  return Object.entries(files).flatMap(([path, text]) =>
    PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => ({ path, kind })),
  );
}
