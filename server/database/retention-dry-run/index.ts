import { type RetentionReportEntry, retentionReport } from "../../domain/index.ts";
import type { WithActor } from "../index.ts";

// One call of the definer RPC (db/main/migrations/20261209130400_retention_dry_run.sql).
// It takes no institution: the session decides which one. It only reads; it answers
// ZD401 without a live session and ZD403 to anyone but the administrator of
// that institution. A count is capped at the integer range so it stays a JS
// number.
const SQL = `SELECT class_key AS "key",
       LEAST(candidates, 2147483647)::integer AS "candidates"
  FROM app.retention_candidates()`;

export type RetentionDryRunResult =
  | { readonly status: "unauthenticated" }
  | { readonly status: "forbidden" }
  | { readonly status: "ok"; readonly classes: readonly RetentionReportEntry[] };

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
    return { status: "ok", classes: retentionReport(counts) };
  };
}
