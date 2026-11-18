import type { Pool } from "pg";

// Provisioning of an institution instance (contract Ductus#2028 c.6993786629
// §2): the port of identity.provision_institution and
// identity.provisioned_institution. Only the internal routes call it, over the
// ductus_auth login (the server-to-server pool, as the back-channel logout);
// the web process login (ductus_app) never holds either function.

/** The seats per role, in the words of the contract. */
export type InstitutionSeats = {
  readonly student: number;
  readonly teacher: number;
  readonly network_engineer: number;
  readonly institution_admin: number;
};

export type InstitutionProvisionInput = {
  readonly slug: string;
  readonly displayName: string;
  readonly aaiHomeOrg: string;
  readonly oidcIssuer: string;
  readonly seats: InstitutionSeats;
};

/**
 * `created` 201 and `existing` 200 (the same data again) carry the id;
 * `slug_taken` and `domain_taken` are 409, `invalid` input the database
 * refuses (ZD422), which the route answers as 400.
 */
export type InstitutionProvisionOutcome =
  | { readonly outcome: "created" | "existing"; readonly institutionId: string }
  | { readonly outcome: "slug_taken" | "domain_taken" | "invalid" };

export type ProvisionedInstitution = {
  readonly institutionId: string;
  readonly slug: string;
  readonly displayName: string;
  readonly aaiHomeOrg: string;
  readonly oidcIssuer: string;
  readonly seats: InstitutionSeats;
};

export type InstitutionProvisioning = {
  provision(input: InstitutionProvisionInput): Promise<InstitutionProvisionOutcome>;
  /** The institution of `slug` when it takes logins, else null. */
  read(slug: string): Promise<ProvisionedInstitution | null>;
};

// The role check runs in the same statement, before the function, as in
// open-session.ts: a plain login of ductus_auth, never of ductus_app, without
// SUPERUSER or BYPASSRLS. The CASE stops the call otherwise.
const IS_AUTH_LOGIN = `(SELECT NOT r.rolsuper AND NOT r.rolbypassrls
          AND pg_catalog.pg_has_role(r.oid, 'ductus_auth', 'USAGE')
          AND NOT pg_catalog.pg_has_role(r.oid, 'ductus_app', 'MEMBER')
     FROM pg_catalog.pg_roles r
    WHERE r.rolname = session_user AND session_user = current_user)`;

const PROVISION_SQL = `
SELECT g.allowed,
       CASE WHEN g.allowed THEN
         (SELECT pg_catalog.row_to_json(p)
            FROM identity.provision_institution($1, $2, $3, $4, $5, $6, $7, $8) p)
       END AS row
  FROM (SELECT ${IS_AUTH_LOGIN} AS allowed) g`;

const READ_SQL = `
SELECT g.allowed,
       CASE WHEN g.allowed THEN
         (SELECT pg_catalog.json_build_object(
                   'institutionId', p.institution_id, 'slug', p.slug,
                   'displayName', p.display_name, 'aaiHomeOrg', p.aai_home_org,
                   'oidcIssuer', p.oidc_issuer, 'student', p.student, 'teacher', p.teacher,
                   'network_engineer', p.network_engineer,
                   'institution_admin', p.institution_admin)
            FROM identity.provisioned_institution($1) p)
       END AS row
  FROM (SELECT ${IS_AUTH_LOGIN} AS allowed) g`;

const NOT_AUTH = "institutionProvisioning: the database connection is not a ductus_auth login";
const OUTCOMES = new Set(["created", "existing", "slug_taken", "domain_taken"]);

type SeatRow = Record<keyof InstitutionSeats, unknown>;
type ReadRow = SeatRow & {
  institutionId: unknown;
  slug: unknown;
  displayName: unknown;
  aaiHomeOrg: unknown;
  oidcIssuer: unknown;
};

const isCount = (value: unknown): value is number => Number.isSafeInteger(value);

function provisionedOf(row: ReadRow): ProvisionedInstitution {
  const { institutionId, slug, displayName, aaiHomeOrg, oidcIssuer } = row;
  const counts = [row.student, row.teacher, row.network_engineer, row.institution_admin];
  if (
    typeof institutionId !== "string" ||
    typeof slug !== "string" ||
    typeof displayName !== "string" ||
    typeof aaiHomeOrg !== "string" ||
    typeof oidcIssuer !== "string" ||
    !counts.every(isCount)
  ) {
    throw new Error("institutionProvisioning: malformed row");
  }
  return {
    institutionId,
    slug,
    displayName,
    aaiHomeOrg,
    oidcIssuer,
    seats: {
      student: row.student as number,
      teacher: row.teacher as number,
      network_engineer: row.network_engineer as number,
      institution_admin: row.institution_admin as number,
    },
  };
}

export function createInstitutionProvisioning(pool: Pick<Pool, "query">): InstitutionProvisioning {
  return {
    async provision(input) {
      try {
        const { rows } = await pool.query<{
          allowed: boolean | null;
          row: { outcome: unknown; institution_id: unknown } | null;
        }>(PROVISION_SQL, [
          input.slug,
          input.displayName,
          input.aaiHomeOrg,
          input.oidcIssuer,
          input.seats.student,
          input.seats.teacher,
          input.seats.network_engineer,
          input.seats.institution_admin,
        ]);
        const first = rows[0];
        if (first?.allowed !== true) throw new Error(NOT_AUTH);
        const { outcome, institution_id } = first.row ?? {};
        if (typeof outcome !== "string" || !OUTCOMES.has(outcome)) {
          throw new Error("institutionProvisioning: malformed row");
        }
        if (outcome === "created" || outcome === "existing") {
          if (typeof institution_id !== "string") {
            throw new Error("institutionProvisioning: malformed row");
          }
          return { outcome, institutionId: institution_id };
        }
        return { outcome: outcome as "slug_taken" | "domain_taken" };
      } catch (error) {
        // Only the code is read: the message carries no input either way.
        if ((error as { code?: unknown } | null)?.code === "ZD422") return { outcome: "invalid" };
        throw error;
      }
    },
    async read(slug) {
      const { rows } = await pool.query<{ allowed: boolean | null; row: ReadRow | null }>(
        READ_SQL,
        [slug],
      );
      const first = rows[0];
      if (first?.allowed !== true) throw new Error(NOT_AUTH);
      return first.row === null ? null : provisionedOf(first.row);
    },
  };
}
