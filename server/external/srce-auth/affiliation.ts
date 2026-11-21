/**
 * The staff affiliation of a login (SRV-1403, M1.3, DAN-304, D-205 t. 4): the
 * one fact a teacher role may be confirmed on. Only the attribute that gave it
 * leaves here, and for a scoped value its scope, which the database compares
 * with the home organisation of the account's institution again
 * (identity.open_session, ten arguments). Never the value itself.
 *
 * Three attributes count, in this order:
 * - eduPersonScopedAffiliation, `employee@<scope>` or `faculty@<scope>`, only
 *   when the scope is the login's home organisation: another institution's
 *   affiliation gives nothing;
 * - hrEduPersonAffiliation, one of TEACHER_AFFILIATIONS (code list hrEdu004);
 * - eduPersonAffiliation, `employee` or `faculty`.
 * The two unscoped attributes describe the home organisation by definition.
 *
 * A missing, malformed or student-only attribute gives no affiliation and
 * never refuses the login: the person stays a student and reads the closed
 * code STAFF_AFFILIATION_MISSING.
 */

/** The attributes an affiliation may come from; the CHECK of identity.staff_affiliation. */
export const STAFF_AFFILIATION_SOURCES = Object.freeze([
  "hrEduPersonAffiliation",
  "eduPersonAffiliation",
  "eduPersonScopedAffiliation",
] as const);
export type StaffAffiliationSource = (typeof STAFF_AFFILIATION_SOURCES)[number];

/** The closed code of a person without a staff affiliation. */
export const STAFF_AFFILIATION_MISSING = "staff_affiliation_missing";

export type StaffAffiliation =
  | { source: "hrEduPersonAffiliation" | "eduPersonAffiliation" }
  | { source: "eduPersonScopedAffiliation"; scope: string };

/**
 * The hrEduPersonAffiliation values that allow a teacher role (D-171).
 *
 * NEPROVJERENO (DAN-304, #1181): not yet read in the source itself, the
 * code list hrEdu004 of the hrEdu schema register
 * (www.aaiedu.hr/sheme/sifrarnici, annex 4 of schema v1.2). `djelatnik` is
 * seen in public extracts, `vanjski suradnik` is not confirmed. When the
 * code list differs, only this constant and its test change.
 */
export const TEACHER_AFFILIATIONS: readonly string[] = Object.freeze([
  "djelatnik",
  "vanjski suradnik",
]);

/** The eduPerson values (eduPerson 201602, eduPersonAffiliation) of a member of staff. */
export const STAFF_EDU_PERSON_VALUES: readonly string[] = Object.freeze(["employee", "faculty"]);

// The attributes are multi-valued; more members than any person holds is not
// an affiliation, and the bound keeps the scan short.
const MAX_AFFILIATIONS = 32;
const MAX_CHARS = 255;
// As claims.ts: controls, separators, invisible format characters and lone
// surrogates make two values that look equal differ.
const UNSAFE = /[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u;
// A home organisation as identity.open_session accepts it.
const SCOPE = /^[a-z0-9.-]{1,255}$/;

type Claims = Readonly<Record<string, unknown>>;

/**
 * The members of a multi-valued attribute: a string counts as one member.
 * Anything that is not a short list of plain strings is no member at all, so
 * a hole or a nested value can never pass for a staff value.
 */
function membersOf(value: unknown): string[] {
  const members: unknown = typeof value === "string" ? [value] : value;
  if (!Array.isArray(members) || members.length > MAX_AFFILIATIONS) return [];
  const out: string[] = [];
  for (let i = 0; i < members.length; i += 1) {
    if (!Object.hasOwn(members, i)) return [];
    const member: unknown = members[i];
    if (
      typeof member === "string" &&
      member !== "" &&
      !UNSAFE.test(member) &&
      [...member].length <= MAX_CHARS
    )
      out.push(member);
  }
  return out;
}

/** The home organisation as the database keeps it: ASCII lower case, edge blanks trimmed. */
function normalOrg(value: string): string | undefined {
  const org = value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "").toLowerCase();
  return SCOPE.test(org) ? org : undefined;
}

/**
 * The staff affiliation the claims give for `homeOrg`, or undefined. The
 * values are compared exactly, with no case folding or trimming; only a
 * scope is compared as a home organisation is.
 */
export function staffAffiliationFromClaims(
  claims: Claims,
  homeOrg: string,
): StaffAffiliation | undefined {
  const home = normalOrg(homeOrg);
  if (home !== undefined) {
    for (const member of membersOf(claims.eduPersonScopedAffiliation)) {
      const at = member.lastIndexOf("@");
      if (at <= 0 || !STAFF_EDU_PERSON_VALUES.includes(member.slice(0, at))) continue;
      const scope = normalOrg(member.slice(at + 1));
      if (scope === home) return { source: "eduPersonScopedAffiliation", scope };
    }
  }
  if (membersOf(claims.hrEduPersonAffiliation).some((m) => TEACHER_AFFILIATIONS.includes(m)))
    return { source: "hrEduPersonAffiliation" };
  if (membersOf(claims.eduPersonAffiliation).some((m) => STAFF_EDU_PERSON_VALUES.includes(m)))
    return { source: "eduPersonAffiliation" };
  return undefined;
}
