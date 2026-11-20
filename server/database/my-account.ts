// The caller's own account for GET /api/v1/me (contract Ductus#2028
// c.6993786629 §3.3): one withActor transaction, one statement. Who the caller
// is comes from the session token inside app.my_account(), never from a
// parameter. ZD401 (no live session) is `unauthenticated`; any other error is
// thrown on, and the route answers it as 503. The internal ids of the person
// and the institution come from app.current_actor() in the same statement, so
// the route can make the journal scope (SRV-JS); they are kept apart from the
// account and never sent.
import type { WithActor } from "./with-actor.ts";

/** The roles app.my_account() may name, in its words. */
export const MY_ACCOUNT_ROLES = [
  "student",
  "teacher",
  "network_engineer",
  "institution_admin",
] as const;
export type MyAccountRole = (typeof MY_ACCOUNT_ROLES)[number];

export type MyAccount = {
  readonly institution: { readonly slug: string; readonly displayName: string | null };
  readonly roles: readonly MyAccountRole[];
  readonly displayName: string | null;
};

export type MyAccountResult =
  | {
      readonly ok: true;
      readonly value: MyAccount;
      readonly userId: string;
      readonly institutionId: string;
    }
  | { readonly ok: false; readonly reason: "unauthenticated" };

export type MyAccountReader = (token: string) => Promise<MyAccountResult>;

const READ_SQL = `SELECT m.institution_slug, m.institution_display_name AS "institutionDisplayName",
       m.display_name AS "displayName", m.roles,
       a.user_id::text AS "userId", a.institution_id::text AS "institutionId"
  FROM app.my_account() m CROSS JOIN app.current_actor() a`;

type Row = {
  institution_slug: unknown;
  institutionDisplayName: unknown;
  displayName: unknown;
  roles: unknown;
  userId: unknown;
  institutionId: unknown;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);

const isRole = (value: unknown): value is MyAccountRole =>
  typeof value === "string" && (MY_ACCOUNT_ROLES as readonly string[]).includes(value);
const isTextOrNull = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

function resultOf(rows: readonly Row[]): MyAccountResult & { ok: true } {
  const row = rows.length === 1 ? rows[0] : undefined;
  if (
    row === undefined ||
    !isUuid(row.userId) ||
    !isUuid(row.institutionId) ||
    typeof row.institution_slug !== "string" ||
    !isTextOrNull(row.institutionDisplayName) ||
    !isTextOrNull(row.displayName) ||
    !Array.isArray(row.roles) ||
    row.roles.length === 0 ||
    !row.roles.every(isRole)
  ) {
    throw new Error("myAccount: malformed row");
  }
  return {
    ok: true,
    value: {
      institution: { slug: row.institution_slug, displayName: row.institutionDisplayName },
      roles: Object.freeze([...(row.roles as MyAccountRole[])]),
      displayName: row.displayName,
    },
    userId: row.userId,
    institutionId: row.institutionId,
  };
}

export function createMyAccountReader(withActor: WithActor): MyAccountReader {
  return async (token) => {
    try {
      const rows = await withActor(token, async (tx) => (await tx.query<Row>(READ_SQL)).rows);
      return resultOf(rows);
    } catch (error) {
      if ((error as { code?: unknown } | null)?.code === "ZD401") {
        return { ok: false, reason: "unauthenticated" };
      }
      throw error;
    }
  };
}
