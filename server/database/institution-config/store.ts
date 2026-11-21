/**
 * SRV-1405: the database port of `app.institution_config`.
 *
 * - `publish`: an administrator adds the next version of the own
 *   institution's rules. The rules pass the closed schema before anything
 *   reaches the database; the institution, the author and the version number
 *   come from the session and the database, never from the caller.
 * - `versions`: the versions of the own institution, through RLS. Only an
 *   administrator reads them; any other caller with a session is "forbidden"
 *   (SRV-1406), so a teacher is told apart from an administrator with none.
 * - `assignmentRules`: the rules an assignment reads, the version it was
 *   created under (`institution.assignment.config_version`). An assignment
 *   created while its institution had no version reads the faculty file
 *   (`./loader.ts`), reported as version null.
 *
 * ZD401, ZD403, ZD409 and ZD422 are outcomes, never thrown; any other error
 * and any row the schema refuses are programming faults and throw.
 */
import type { WithActor } from "../index.ts";

import { FACULTY_RULES_MAX_BYTES, facultyRulesSchema, type FacultyRules } from "./schema.ts";

export type InstitutionConfigVersion = {
  readonly version: number;
  readonly rules: FacultyRules;
  readonly createdBy: string;
  readonly createdAt: string;
};

export type PublishOutcome =
  | { readonly status: "ok"; readonly version: number }
  | { readonly status: "unauthorized" | "forbidden" | "conflict" | "invalid_input" };

export type VersionsOutcome =
  | { readonly status: "ok"; readonly versions: readonly InstitutionConfigVersion[] }
  | { readonly status: "unauthorized" | "forbidden" };

export type AssignmentRulesOutcome =
  | { readonly status: "ok"; readonly version: number | null; readonly rules: FacultyRules | null }
  | { readonly status: "unauthorized" | "not_found" };

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;

const SQL = {
  publish: "SELECT app.publish_institution_config($1::integer, $2::jsonb) AS version",
  versions: `SELECT (SELECT a.user_id FROM app.current_actor() a) IS NOT NULL AS authenticated,
      (SELECT institution.actor_has_role('admin')) AS administrator,
      c.version, c.rules, c.created_by AS "createdBy", c.created_at AS "createdAt"
    FROM (SELECT 1) one LEFT JOIN app.institution_config c ON true
    ORDER BY c.version`,
  assignment: "SELECT version, rules FROM app.assignment_institution_config($1::uuid)",
} as const;

function codeOf(error: unknown): unknown {
  try {
    return error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    return undefined;
  }
}

function storedRules(value: unknown): FacultyRules {
  const parsed = facultyRulesSchema.safeParse(value);
  if (!parsed.success) throw new Error("invalid stored institution config");
  return parsed.data;
}

type VersionRow = {
  authenticated: boolean;
  administrator: boolean | null;
  version: number | null;
  rules: unknown;
  createdBy: string | null;
  createdAt: Date | null;
};

export function createInstitutionConfigStore(withActor: WithActor) {
  return {
    async publish(token: string, expectedVersion: number, rules: unknown): Promise<PublishOutcome> {
      const parsed = facultyRulesSchema.safeParse(rules);
      if (
        !parsed.success ||
        !Number.isSafeInteger(expectedVersion) ||
        expectedVersion < 0 ||
        Buffer.byteLength(JSON.stringify(parsed.data)) > FACULTY_RULES_MAX_BYTES
      ) {
        return { status: "invalid_input" };
      }
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<{ version: number }>(SQL.publish, [
            expectedVersion,
            JSON.stringify(parsed.data),
          ]);
          const version = rows[0]?.version;
          if (
            rows.length !== 1 ||
            !Number.isSafeInteger(version) ||
            version !== expectedVersion + 1
          ) {
            throw new Error("invalid published institution config version");
          }
          return { status: "ok", version } as const;
        });
      } catch (error) {
        const code = codeOf(error);
        if (code === "ZD401") return { status: "unauthorized" };
        if (code === "ZD403") return { status: "forbidden" };
        if (code === "ZD409") return { status: "conflict" };
        if (code === "ZD422") return { status: "invalid_input" };
        throw error;
      }
    },

    versions(token: string): Promise<VersionsOutcome> {
      return withActor(token, async (tx) => {
        const { rows } = await tx.query<VersionRow>(SQL.versions, []);
        const first = rows[0];
        if (first === undefined) throw new Error("missing institution config result");
        if (!first.authenticated) return { status: "unauthorized" } as const;
        if (first.administrator !== true) return { status: "forbidden" } as const;
        const versions = rows
          .filter((row) => row.version !== null)
          .map((row, index) => {
            if (
              row.version !== index + 1 ||
              row.createdBy === null ||
              !(row.createdAt instanceof Date)
            ) {
              throw new Error("invalid institution config chain");
            }
            return {
              version: row.version,
              rules: storedRules(row.rules),
              createdBy: row.createdBy,
              createdAt: row.createdAt.toISOString(),
            };
          });
        return { status: "ok", versions } as const;
      });
    },

    async assignmentRules(
      token: string,
      assignmentId: string,
      fileRules: FacultyRules | null,
    ): Promise<AssignmentRulesOutcome> {
      if (!ID.test(assignmentId)) return { status: "not_found" };
      try {
        return await withActor(token, async (tx) => {
          const { rows } = await tx.query<{ version: number; rules: unknown }>(SQL.assignment, [
            assignmentId,
          ]);
          if (rows.length > 1) throw new Error("more than one institution config of an assignment");
          const row = rows[0];
          if (row === undefined) return { status: "ok", version: null, rules: fileRules } as const;
          return { status: "ok", version: row.version, rules: storedRules(row.rules) } as const;
        });
      } catch (error) {
        const code = codeOf(error);
        if (code === "ZD401") return { status: "unauthorized" };
        if (code === "ZD403") return { status: "not_found" };
        throw error;
      }
    },
  };
}

export type InstitutionConfigStore = ReturnType<typeof createInstitutionConfigStore>;
