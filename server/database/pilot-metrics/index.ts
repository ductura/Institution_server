import type { WithActor } from "../index.ts";

// One call of the definer RPC (db/main/migrations/20261201110000_pilot_metrics.sql).
// The database already hides small groups; the reader checks it again and
// refuses a row that would publish one.
const SQL = `SELECT as_of AS "asOf",
       submissions_recorded AS "submissionsRecorded",
       submissions_not_recorded AS "submissionsNotRecorded",
       receipts_issued AS "receiptsIssued",
       receipts_pending AS "receiptsPending",
       help_requests AS "helpRequests",
       save_problem_reports AS "saveProblemReports",
       receipt_p50_ms AS "receiptP50Ms",
       receipt_p95_ms AS "receiptP95Ms"
  FROM app.pilot_metrics()`;

const MIN_GROUP = 5;

export type PilotMetricsRow = {
  readonly asOf: Date;
  readonly submissionsRecorded: number | null;
  readonly submissionsNotRecorded: number | null;
  readonly receiptsIssued: number | null;
  readonly receiptsPending: number | null;
  readonly helpRequests: number | null;
  readonly saveProblemReports: number | null;
  readonly receiptP50Ms: number | null;
  readonly receiptP95Ms: number | null;
};

export type PilotMetricsResult =
  | { readonly status: "unauthenticated" }
  | { readonly status: "ok"; readonly metrics: PilotMetricsRow };

type Row = Record<string, unknown>;

const isCount = (value: unknown): value is number | null =>
  value === null ||
  (typeof value === "number" && Number.isSafeInteger(value) && (value === 0 || value >= MIN_GROUP));
const isDuration = (value: unknown): value is number | null =>
  value === null || (typeof value === "number" && Number.isSafeInteger(value) && value >= 0);

const isNotAuthenticated = (error: unknown): boolean =>
  typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ZD401";

export function createPilotMetricsReader(withActor: WithActor) {
  return async (token: string): Promise<PilotMetricsResult> => {
    let rows: readonly Row[];
    try {
      ({ rows } = await withActor(token, (tx) => tx.query<Row>(SQL)));
    } catch (error) {
      if (isNotAuthenticated(error)) return { status: "unauthenticated" };
      throw error;
    }
    if (rows.length !== 1) throw new Error("pilot metrics: expected one row");
    const row = rows[0]!;
    const count = (name: string): number | null => {
      const value = row[name];
      if (!isCount(value)) throw new Error("pilot metrics: invalid row");
      return value;
    };
    const duration = (name: string): number | null => {
      const value = row[name];
      if (!isDuration(value)) throw new Error("pilot metrics: invalid row");
      return value;
    };
    const asOf = row.asOf;
    if (!(asOf instanceof Date) || Number.isNaN(asOf.getTime())) {
      throw new Error("pilot metrics: invalid row");
    }
    return {
      status: "ok",
      metrics: {
        asOf,
        submissionsRecorded: count("submissionsRecorded"),
        submissionsNotRecorded: count("submissionsNotRecorded"),
        receiptsIssued: count("receiptsIssued"),
        receiptsPending: count("receiptsPending"),
        helpRequests: count("helpRequests"),
        saveProblemReports: count("saveProblemReports"),
        receiptP50Ms: duration("receiptP50Ms"),
        receiptP95Ms: duration("receiptP95Ms"),
      },
    };
  };
}
