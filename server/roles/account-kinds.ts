// The five account kinds of Ductura (Ductus D-297, docs/account-permissions.md).
// The Ductus operator (D-172, D-305) is not one of them: whether it is a
// separate account is still open, so it is not listed here.

/** Account kinds, in the column order of docs/account-permissions.md. */
export const ACCOUNT_KINDS = Object.freeze([
  "student",
  "teacher",
  "institution_admin",
  "app_admin",
  "network_engineer",
] as const);

export type AccountKind = (typeof ACCOUNT_KINDS)[number];

export const LOGIN_METHODS_KNOWN = Object.freeze(["aai_eduhr", "fido2"] as const);

export type LoginMethod = (typeof LOGIN_METHODS_KNOWN)[number];

/** Login of one kind; `not_built`: the app admin login is not built yet (D-297, question 8). */
export type Login = readonly LoginMethod[] | "not_built";

const LOGIN_ROWS = [
  ["student", ["aai_eduhr"]],
  ["teacher", ["aai_eduhr"]],
  ["institution_admin", ["aai_eduhr"]],
  ["app_admin", "not_built"],
  ["network_engineer", ["aai_eduhr", "fido2"]],
] as const satisfies readonly (readonly [AccountKind, Login])[];

type AssertTrue<T extends true> = T;

/** Fails to compile when a kind has no login row. */
export type EveryKindHasALogin = AssertTrue<
  [Exclude<AccountKind, (typeof LOGIN_ROWS)[number][0]>] extends [never] ? true : false
>;

// How each kind signs in (D-297, D-09, D-16). Not exported; read it through loginOf.
const LOGIN_METHODS: ReadonlyMap<AccountKind, Login> = new Map<AccountKind, Login>(LOGIN_ROWS);

/** Login rows, for tests; one row per kind in the order of ACCOUNT_KINDS. */
export { LOGIN_ROWS };

/** Login of `kind`; `not_built` for an unknown value, so nothing signs in by mistake. */
export function loginOf(kind: unknown): Login {
  return (isAccountKind(kind) ? LOGIN_METHODS.get(kind) : undefined) ?? "not_built";
}

/** True for a value that is one of the five account kinds. */
export function isAccountKind(value: unknown): value is AccountKind {
  return typeof value === "string" && (ACCOUNT_KINDS as readonly string[]).includes(value);
}
