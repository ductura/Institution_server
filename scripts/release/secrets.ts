// Strings that must never be in a published package. The fakes use generated
// keys at run time, so no published file carries key material.
const PATTERNS: readonly [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{36,}\b/u],
  ["GitHub token", /\bgithub_pat_[A-Za-z0-9_]{22,}\b/u],
  ["npm token", /\bnpm_[A-Za-z0-9]{36}\b/u],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
  ["database URL with password", /\bpostgres(?:ql)?:\/\/[^\s/:@"']+:[^\s/@"']+@/u],
];

export type SecretFinding = { readonly path: string; readonly kind: string };

/** Every file of `files` (path → text) that holds something like a secret. */
export function scanSecrets(files: Readonly<Record<string, string>>): SecretFinding[] {
  return Object.entries(files).flatMap(([path, text]) =>
    PATTERNS.filter(([, pattern]) => pattern.test(text)).map(([kind]) => ({ path, kind })),
  );
}
