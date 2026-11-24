// SRV-ADMIN-1 (NF-7 OA-7): the problem reports that reach the caller and their
// state (migration 20261215100000_problem_report_routing.sql). Which reports
// reach whom is the database's: a network engineer the technical ones, a
// confirmed administrator the account ones and course ones naming no course,
// a course team the ones about its course. No row names who sent a report.
// ZD401, ZD403, ZD404 and ZD422 become refusals; anything else, or a row
// outside its class, is "unavailable".
import type { WithActor } from "../index.ts";

const CATEGORIES = ["technical", "account", "course"] as const;
const ROUTED_TO = ["network_engineer", "course_teacher", "institution_admin"] as const;
const STATUSES = ["received", "resolved"] as const;
const FAMILIES = ["chromium", "firefox", "safari", "other"] as const;
const SYNC_STATES = [
  ...["EDITING", "SAVING_LOCAL", "LOCAL_DURABLE", "SYNCING", "SYNCED", "CONFLICT", "ERROR"],
  "RECOVERY_REQUIRED",
] as const;
const REFERENCE = /^PR-[0-9A-F]{10}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type ProblemReportStatus = (typeof STATUSES)[number];
export type ProblemReportRoutedTo = (typeof ROUTED_TO)[number];

export type RoutedProblemReportRow = {
  readonly reference: string;
  readonly category: (typeof CATEGORIES)[number];
  readonly routedTo: ProblemReportRoutedTo;
  readonly courseId: string | null;
  readonly description: string;
  readonly route: string | null;
  readonly appVersion: string;
  readonly browser: { readonly family: (typeof FAMILIES)[number]; readonly major: number | null };
  readonly syncState: (typeof SYNC_STATES)[number] | null;
  readonly createdAt: string;
  readonly status: ProblemReportStatus;
  readonly statusChangedAt: string | null;
  readonly statusChangedByRole: ProblemReportRoutedTo | null;
  readonly statusChangedByMe: boolean;
};

type Refusal = {
  readonly status: "unauthenticated" | "forbidden" | "not_found" | "invalid" | "unavailable";
};

export type ProblemReportInbox = {
  /** At most `limit` reports, newest first; `truncated` when more exist. */
  list(
    token: string,
    limit: number,
  ): Promise<{ status: "ok"; reports: RoutedProblemReportRow[]; truncated: boolean } | Refusal>;
  setStatus(
    token: string,
    reference: string,
    status: ProblemReportStatus,
  ): Promise<
    { status: "ok"; reportStatus: ProblemReportStatus; changedAt: string | null } | Refusal
  >;
};

const REFUSALS = new Map<unknown, Refusal["status"]>([
  ["ZD401", "unauthenticated"],
  ["ZD403", "forbidden"],
  ["ZD404", "not_found"],
  ["ZD422", "invalid"],
]);

function refusal(error: unknown): Refusal {
  let code: unknown;
  try {
    code = error !== null && typeof error === "object" && "code" in error ? error.code : undefined;
  } catch {
    code = undefined;
  }
  return { status: REFUSALS.get(code) ?? "unavailable" };
}

const member = <T extends string>(values: readonly T[], value: unknown): value is T =>
  typeof value === "string" && (values as readonly string[]).includes(value);

function instant(value: unknown): string | undefined {
  return value instanceof Date && !Number.isNaN(value.getTime()) ? value.toISOString() : undefined;
}

function reportOf(row: Record<string, unknown>): RoutedProblemReportRow | undefined {
  const createdAt = instant(row.createdAt);
  const statusChangedAt = row.statusChangedAt === null ? null : instant(row.statusChangedAt);
  const major = row.browserMajor;
  if (
    typeof row.reference !== "string" ||
    !REFERENCE.test(row.reference) ||
    !member(CATEGORIES, row.category) ||
    !member(ROUTED_TO, row.routedTo) ||
    !(row.courseId === null || (typeof row.courseId === "string" && UUID.test(row.courseId))) ||
    typeof row.description !== "string" ||
    row.description.length === 0 ||
    !(row.route === null || typeof row.route === "string") ||
    typeof row.appVersion !== "string" ||
    !member(FAMILIES, row.browserFamily) ||
    !(major === null || (typeof major === "number" && Number.isInteger(major))) ||
    !(row.syncState === null || member(SYNC_STATES, row.syncState)) ||
    createdAt === undefined ||
    !member(STATUSES, row.status) ||
    statusChangedAt === undefined ||
    !(row.statusChangedByRole === null || member(ROUTED_TO, row.statusChangedByRole)) ||
    (statusChangedAt === null) !== (row.statusChangedByRole === null) ||
    typeof row.statusChangedByMe !== "boolean"
  ) {
    return undefined;
  }
  return {
    reference: row.reference,
    category: row.category,
    routedTo: row.routedTo,
    courseId: row.courseId,
    description: row.description,
    route: row.route,
    appVersion: row.appVersion,
    browser: { family: row.browserFamily, major },
    syncState: row.syncState,
    createdAt,
    status: row.status,
    statusChangedAt,
    statusChangedByRole: row.statusChangedByRole,
    statusChangedByMe: row.statusChangedByMe,
  };
}

const LIST_SQL = `SELECT reference, category, routed_to AS "routedTo", course_id AS "courseId", description, route,
       app_version AS "appVersion", browser_family AS "browserFamily", browser_major AS "browserMajor",
       sync_state AS "syncState", created_at AS "createdAt", status, status_changed_at AS "statusChangedAt",
       status_changed_by_role AS "statusChangedByRole", status_changed_by_me AS "statusChangedByMe"
  FROM identity.routed_problem_reports() LIMIT $1`;
const SET_SQL = 'SELECT identity.set_problem_report_status($1, $2) AS "changedAt"';

export function createProblemReportInbox(withActor: WithActor): ProblemReportInbox {
  return {
    async list(token, limit) {
      let rows: readonly Record<string, unknown>[];
      try {
        ({ rows } = await withActor(token, (tx) =>
          tx.query<Record<string, unknown>>(LIST_SQL, [limit + 1]),
        ));
      } catch (error) {
        return refusal(error);
      }
      const reports: RoutedProblemReportRow[] = [];
      for (const row of rows.slice(0, limit)) {
        const report = reportOf(row);
        if (report === undefined) return { status: "unavailable" };
        reports.push(report);
      }
      return { status: "ok", reports, truncated: rows.length > limit };
    },

    async setStatus(token, reference, status) {
      if (!REFERENCE.test(reference) || !member(STATUSES, status)) return { status: "invalid" };
      let rows: readonly Record<string, unknown>[];
      try {
        ({ rows } = await withActor(token, (tx) =>
          tx.query<Record<string, unknown>>(SET_SQL, [reference, status]),
        ));
      } catch (error) {
        return refusal(error);
      }
      if (rows.length !== 1) return { status: "unavailable" };
      const raw = rows[0]!.changedAt;
      const changedAt = raw === null ? null : instant(raw);
      if (changedAt === undefined) return { status: "unavailable" };
      // A state changed away from "received" always has a time.
      if (changedAt === null && status !== "received") return { status: "unavailable" };
      return { status: "ok", reportStatus: status, changedAt };
    },
  };
}
