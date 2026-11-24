import {
  RETENTION_CATALOG,
  type RetentionReportEntry,
  retentionReport,
} from "../../domain/index.ts";
import type { WithActor } from "../index.ts";

// One call of the definer RPC (db/main/migrations/20261210130400_retention_dry_run.sql).
// It takes no institution: the session decides which one. It only reads; it answers
// ZD401 without a live session and ZD403 to anyone but the administrator of
// that institution. A count is capped at the integer range so it stays a JS
// number.
const SQL = `SELECT class_key AS "key",
       LEAST(candidates, 2147483647)::integer AS "candidates"
  FROM app.retention_candidates()`;

/**
 * SRV-ADMIN-3 (owner decision of 23. 11. 2026., item 5): why a period is what
 * it is. A number of days is decided; a null period of a class that may be
 * deleted waits for a decision (the faculty sets it, so no period is made up); the class that is never deleted (hashes and receipts)
 * keeps its null period for that reason.
 */
export type RetentionPeriodStatus = "decided" | "awaiting_decision" | "never_deleted";

// Pairs, not object keys, so the snake_case statuses stay values (naming-convention).
const PERIOD_STATUS_KEYS = new Map([
  ["decided", "adminSettings.retentionPeriod.decided"],
  ["awaiting_decision", "adminSettings.retentionPeriod.awaitingDecision"],
  ["never_deleted", "adminSettings.retentionPeriod.neverDeleted"],
] as const);

export type RetentionPeriodStatusKey =
  | "adminSettings.retentionPeriod.decided"
  | "adminSettings.retentionPeriod.awaitingDecision"
  | "adminSettings.retentionPeriod.neverDeleted";

export type RetentionClassEntry = RetentionReportEntry & {
  readonly periodStatus: RetentionPeriodStatus;
  readonly periodStatusKey: RetentionPeriodStatusKey;
};

/** The status of one entry of the report; an unknown class is an error, not a guess. */
export function retentionPeriodStatus(entry: RetentionReportEntry): RetentionPeriodStatus {
  const known = RETENTION_CATALOG.find((item) => item.key === entry.key);
  if (known === undefined) throw new Error("retention: unknown class");
  if (!known.erasable) return "never_deleted";
  return entry.retentionDays === null ? "awaiting_decision" : "decided";
}

/** The report with the status of each period and the key of its text. */
export function withPeriodStatus(
  entries: readonly RetentionReportEntry[],
): readonly RetentionClassEntry[] {
  return entries.map((entry) => {
    const periodStatus = retentionPeriodStatus(entry);
    return { ...entry, periodStatus, periodStatusKey: PERIOD_STATUS_KEYS.get(periodStatus)! };
  });
}

/** The keys of the classes whose period still waits for a decision, in catalogue order. */
export function classesAwaitingDecision(): readonly string[] {
  return withPeriodStatus(retentionReport(new Map()))
    .filter((entry) => entry.periodStatus === "awaiting_decision")
    .map((entry) => entry.key);
}

export type RetentionDryRunResult =
  | { readonly status: "unauthenticated" }
  | { readonly status: "forbidden" }
  | { readonly status: "ok"; readonly classes: readonly RetentionClassEntry[] };

type Row = { key?: unknown; candidates?: unknown };

const codeOf = (error: unknown): unknown =>
  typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

export function createRetentionDryRunReader(withActor: WithActor) {
  return async (token: string): Promise<RetentionDryRunResult> => {
    let rows: readonly Row[];
    try {
      ({ rows } = await withActor(token, (tx) => tx.query<Row>(SQL)));
    } catch (error) {
      const code = codeOf(error);
      if (code === "ZD401") return { status: "unauthenticated" };
      if (code === "ZD403") return { status: "forbidden" };
      throw error;
    }
    const counts = new Map<string, number | null>();
    for (const row of rows) {
      const { key, candidates } = row;
      if (typeof key !== "string" || counts.has(key)) throw new Error("retention: invalid row");
      if (candidates !== null && typeof candidates !== "number") {
        throw new Error("retention: invalid row");
      }
      counts.set(key, candidates);
    }
    // retentionReport refuses an unknown class or an invalid count.
    return { status: "ok", classes: withPeriodStatus(retentionReport(counts)) };
  };
}
