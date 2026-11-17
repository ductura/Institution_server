// The problem report port (DAN-851-2c1; contract Ductus#1836 c.6944497890).
// Port of the RPC call in Ductus src/server/support/problem-report-route.ts at
// 81833ca: one withActor transaction per report, one statement, the reference
// checked before it leaves this folder. Who reports, and for which
// institution, comes from the session token inside
// identity.submit_problem_report(), never from a parameter. As in
// interface-locale.ts, every outcome is a Result with an AppError
// (docs/CODE_STYLE.md §8; text in locales/hr.json under `problemReport`) and
// nothing is logged here. Deviations from Ductus, all a 503 there as at the
// route: another SQLSTATE becomes the closed DATABASE_ERROR (the route logs
// that code), reading `code` cannot throw, and rows that are not an array are
// ROW_MALFORMED.
import { type AppError, type ProblemReport, type Result } from "../domain/index.ts";

import type { WithActor } from "./with-actor.ts";

const error = (code: string, messageKey: string): AppError => ({ code, messageKey });

/** ZD401: no live session behind the token. */
export const PROBLEM_REPORT_UNAUTHENTICATED = error(
  "PROBLEM_REPORT_UNAUTHENTICATED",
  "problemReport.unauthenticated",
);
/** ZD422: the database refused a value outside its class. */
export const PROBLEM_REPORT_INVALID = error("PROBLEM_REPORT_INVALID", "problemReport.invalid");
/** ZD429: the caller's hourly limit of reports is reached. */
export const PROBLEM_REPORT_TOO_MANY = error("PROBLEM_REPORT_TOO_MANY", "problemReport.too_many");
/** Not exactly one row, or a reference not of the form PR-<10 upper hex>. */
export const PROBLEM_REPORT_ROW_MALFORMED = error(
  "PROBLEM_REPORT_ROW_MALFORMED",
  "problemReport.row_malformed",
);
/** Any other error of the database or of withActor. */
export const PROBLEM_REPORT_DATABASE_ERROR = error(
  "PROBLEM_REPORT_DATABASE_ERROR",
  "problemReport.database_error",
);
export const PROBLEM_REPORT_ERRORS: readonly AppError[] = [
  PROBLEM_REPORT_UNAUTHENTICATED,
  PROBLEM_REPORT_INVALID,
  PROBLEM_REPORT_TOO_MANY,
  PROBLEM_REPORT_ROW_MALFORMED,
  PROBLEM_REPORT_DATABASE_ERROR,
];

/** The report's fields in the order of the RPC's parameters (p_category ... p_sync_state). */
export const PROBLEM_REPORT_PARAMETERS = Object.freeze([
  "category",
  "description",
  "route",
  "appVersion",
  "browserFamily",
  "browserMajor",
  "syncState",
] as const satisfies readonly (keyof ProblemReport)[]);

/** The port the problem report service submits through. */
export type ProblemReportStore = {
  submit(token: string, report: ProblemReport): Promise<Result<string>>;
};

// Spelled out in full, as in Ductus, so a search for "identity.<name>(" finds it.
const SUBMIT_SQL =
  "SELECT identity.submit_problem_report($1, $2, $3, $4, $5, $6::integer, $7) AS reference";
const REFERENCE = /^PR-[0-9A-F]{10}$/;
const KNOWN: ReadonlyMap<unknown, AppError> = new Map([
  ["ZD401", PROBLEM_REPORT_UNAUTHENTICATED],
  ["ZD422", PROBLEM_REPORT_INVALID],
  ["ZD429", PROBLEM_REPORT_TOO_MANY],
]);
const fail = (e: AppError): { ok: false; error: AppError } => ({ ok: false, error: e });

/** The code of a database error; a getter or Proxy that throws has none. */
function codeOf(thrown: unknown): unknown {
  try {
    return thrown && typeof thrown === "object" && "code" in thrown ? thrown.code : undefined;
  } catch {
    return undefined;
  }
}

/** The one row's reference, or null; reading what withActor answered may throw. */
function referenceOf(result: unknown): string | null {
  const rows: unknown = (result as { rows?: unknown }).rows;
  if (!Array.isArray(rows) || rows.length !== 1) return null;
  const row: unknown = rows[0];
  if (row === null || typeof row !== "object") return null;
  const reference: unknown = (row as { reference?: unknown }).reference;
  return typeof reference === "string" && REFERENCE.test(reference) ? reference : null;
}

/** The problem report port over a withActor; it never throws. */
export function createProblemReportStore(withActor: WithActor): ProblemReportStore {
  return {
    async submit(token, report) {
      let result: unknown;
      try {
        const values = PROBLEM_REPORT_PARAMETERS.map((key) => report[key]);
        result = await withActor(token, (tx) =>
          tx.query<{ reference: unknown }>(SUBMIT_SQL, values),
        );
      } catch (thrown) {
        return fail(KNOWN.get(codeOf(thrown)) ?? PROBLEM_REPORT_DATABASE_ERROR);
      }
      let reference: string | null;
      try {
        // A getter or Proxy in the answer must not escape as a rejected promise.
        reference = referenceOf(result);
      } catch {
        reference = null;
      }
      if (reference === null) return fail(PROBLEM_REPORT_ROW_MALFORMED);
      return { ok: true, value: reference };
    },
  };
}
