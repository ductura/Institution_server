// SRV-ADMIN-1 (NF-7 OA-3): the log of administrator and operator actions of
// the caller's institution (app.admin_action_log, migrations
// 20261215100100_admin_action_log.sql and 20261217130000_admin_action_log_roster_import.sql). Only a confirmed administrator reads
// it (ZD403 otherwise, ZD401 without a session). A row is a time, the acting
// role, the kind of action, the role it concerns and the outcome; any other
// value, or a row outside these sets, is "unavailable".
import type { WithActor } from "../index.ts";

const ACTIONS = [
  "role_confirmed",
  "role_revoked",
  "rule_published",
  "threshold_changed",
  "hold_placed",
  "hold_released",
  "export_requested",
  "export_approved",
  "roster_import_confirmed",
] as const;
const ACTOR_ROLES = ["institution_admin", "registry_clerk", "operator"] as const;
const SUBJECT_ROLES = [
  "teacher",
  "institution_admin",
  "network_engineer",
  "registry_clerk",
] as const;
const ROLE_ACTIONS: readonly string[] = ["role_confirmed", "role_revoked"];

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ROSTER_IMPORT_MAX_ROWS = 1000;

export type AdminRosterImportCounts = {
  readonly courseId: string;
  readonly enrolled: number;
  readonly alreadyEnrolled: number;
  readonly skipped: number;
};

export type AdminActionRow = {
  readonly at: string;
  readonly actorRole: (typeof ACTOR_ROLES)[number];
  readonly action: (typeof ACTIONS)[number];
  readonly subjectRole: (typeof SUBJECT_ROLES)[number] | null;
  readonly outcome: "completed";
  /** The counts of a confirmed roster import; null for any other action. */
  readonly rosterImport: AdminRosterImportCounts | null;
};

export type AdminActionLog = {
  /** At most `limit` entries, newest first; `truncated` when more exist. */
  read(
    token: string,
    limit: number,
  ): Promise<
    | { status: "ok"; entries: AdminActionRow[]; truncated: boolean }
    | { status: "unauthenticated" | "forbidden" | "unavailable" }
  >;
};

const member = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

const isCount = (value: unknown): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= ROSTER_IMPORT_MAX_ROWS;

// Only a confirmed import carries its course and counts, and it carries all
// four; any other action carries none of them.
function rosterImportOf(row: Record<string, unknown>): AdminRosterImportCounts | null | undefined {
  const parts = [row.courseId, row.enrolled, row.alreadyEnrolled, row.skipped];
  if (row.action !== "roster_import_confirmed") {
    return parts.every((part) => part === null) ? null : undefined;
  }
  if (
    typeof row.courseId !== "string" ||
    !LOWER_UUID.test(row.courseId) ||
    !isCount(row.enrolled) ||
    !isCount(row.alreadyEnrolled) ||
    !isCount(row.skipped)
  ) {
    return undefined;
  }
  return {
    courseId: row.courseId,
    enrolled: row.enrolled,
    alreadyEnrolled: row.alreadyEnrolled,
    skipped: row.skipped,
  };
}

function entryOf(row: Record<string, unknown>): AdminActionRow | undefined {
  const at =
    row.at instanceof Date && !Number.isNaN(row.at.getTime()) ? row.at.toISOString() : undefined;
  const rosterImport = rosterImportOf(row);
  if (
    at === undefined ||
    rosterImport === undefined ||
    !member(ACTOR_ROLES, row.actorRole) ||
    !member(ACTIONS, row.action) ||
    !(row.subjectRole === null || member(SUBJECT_ROLES, row.subjectRole)) ||
    // A role action names its role; nothing else does.
    ROLE_ACTIONS.includes(row.action) !== (row.subjectRole !== null) ||
    // An import is an administrator's action.
    (row.action === "roster_import_confirmed" && row.actorRole !== "institution_admin") ||
    row.outcome !== "completed"
  ) {
    return undefined;
  }
  return {
    at,
    actorRole: row.actorRole,
    action: row.action,
    subjectRole: row.subjectRole,
    outcome: "completed",
    rosterImport,
  };
}

const SQL = `SELECT occurred_at AS "at", actor_role AS "actorRole", action, subject_role AS "subjectRole", outcome,
  course_id AS "courseId", enrolled_count AS "enrolled", already_enrolled_count AS "alreadyEnrolled",
  skipped_count AS "skipped"
  FROM app.admin_action_log() LIMIT $1`;

export function createAdminActionLog(withActor: WithActor): AdminActionLog {
  return {
    async read(token, limit) {
      let rows: readonly Record<string, unknown>[];
      try {
        ({ rows } = await withActor(token, (tx) =>
          tx.query<Record<string, unknown>>(SQL, [limit + 1]),
        ));
      } catch (error) {
        let code: unknown;
        try {
          code =
            error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
        } catch {
          code = undefined;
        }
        if (code === "ZD401") return { status: "unauthenticated" };
        if (code === "ZD403") return { status: "forbidden" };
        return { status: "unavailable" };
      }
      const entries: AdminActionRow[] = [];
      for (const row of rows.slice(0, limit)) {
        const entry = entryOf(row);
        if (entry === undefined) return { status: "unavailable" };
        entries.push(entry);
      }
      return { status: "ok", entries, truncated: rows.length > limit };
    },
  };
}
