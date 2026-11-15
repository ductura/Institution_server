// S-1F-e (DAN-785): where a database migrated in PGlite may differ from the
// same database migrated in real PostgreSQL. Each entry is one line of the
// catalogue fingerprint (parity.ts) that only one engine has, with the reason.
// The parity test fails on a difference not listed here and on an entry that
// no longer differs, so the list never holds more than is true. A difference
// in an object of a migration (table, column, policy, function) is not
// written here: it is reported on Ductus#1836 first (contract c.6897861235).

export type ParityException = {
  /** Name in scripts/db/databases.ts. */
  readonly database: string;
  /** The engine whose fingerprint has the line. */
  readonly only: "pglite" | "postgres";
  /** The fingerprint line, exactly. */
  readonly line: string;
  readonly reason: string;
};

export const PARITY_EXCEPTIONS: readonly ParityException[] = Object.freeze([]);
