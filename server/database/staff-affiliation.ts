// The caller's own staff affiliation for GET /api/v1/me/staff-affiliation
// (SRV-1403, M1.3, DAN-304): one withActor transaction, one statement over
// identity.my_staff_affiliation(), which takes no argument and reads only the
// row of the session's person. No row means no affiliation: the person stays
// a student and reads the closed code staff_affiliation_missing. ZD401 (no
// live session) is `unauthenticated`; any other error, and a row that is not
// what the function returns, is thrown on and the route answers it as 503.
import type { WithActor } from "./with-actor.ts";

/** The sources identity.staff_affiliation allows (its CHECK). */
export const STAFF_AFFILIATION_SOURCE_NAMES = [
  "hrEduPersonAffiliation",
  "eduPersonAffiliation",
  "eduPersonScopedAffiliation",
] as const;
export type StaffAffiliationSourceName = (typeof STAFF_AFFILIATION_SOURCE_NAMES)[number];

/** The closed code of a person without a staff affiliation. */
export const STAFF_AFFILIATION_MISSING_CODE = "staff_affiliation_missing";

export type MyStaffAffiliation =
  | {
      readonly confirmed: true;
      readonly source: StaffAffiliationSourceName;
      readonly confirmedAt: string;
    }
  | { readonly confirmed: false; readonly code: typeof STAFF_AFFILIATION_MISSING_CODE };

export type MyStaffAffiliationResult =
  | { readonly ok: true; readonly value: MyStaffAffiliation }
  | { readonly ok: false; readonly reason: "unauthenticated" };

export type MyStaffAffiliationReader = (token: string) => Promise<MyStaffAffiliationResult>;

const READ_SQL = `SELECT a.source, a.confirmed_at AS "confirmedAt" FROM identity.my_staff_affiliation() a`;

type Row = { source: unknown; confirmedAt: unknown };

const isSource = (value: unknown): value is StaffAffiliationSourceName =>
  typeof value === "string" &&
  (STAFF_AFFILIATION_SOURCE_NAMES as readonly string[]).includes(value);

/** The answer for the rows of identity.my_staff_affiliation(); throws on any other shape. */
export function myStaffAffiliationOf(rows: readonly Row[]): MyStaffAffiliation {
  if (rows.length === 0) return { confirmed: false, code: STAFF_AFFILIATION_MISSING_CODE };
  const row = rows.length === 1 ? rows[0] : undefined;
  const at = row?.confirmedAt;
  if (
    row === undefined ||
    !isSource(row.source) ||
    !(at instanceof Date) ||
    !Number.isFinite(at.getTime())
  ) {
    throw new Error("myStaffAffiliation: malformed row");
  }
  return { confirmed: true, source: row.source, confirmedAt: at.toISOString() };
}

export function createMyStaffAffiliationReader(withActor: WithActor): MyStaffAffiliationReader {
  return async (token) => {
    try {
      const rows = await withActor(token, async (tx) => (await tx.query<Row>(READ_SQL)).rows);
      return { ok: true, value: myStaffAffiliationOf(rows) };
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ZD401") {
        return { ok: false, reason: "unauthenticated" };
      }
      throw error;
    }
  };
}
