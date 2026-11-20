import type { ProcessSummarySource } from "../../../server/application/ports/process-summary-source.ts";
import type { WithActor } from "../../../server/database/index.ts";
import { sourceResult } from "../../../server/database/replay-source.ts";

export function processSummarySource(withActor: WithActor, token: string): ProcessSummarySource {
  return {
    async readSource(documentId) {
      try {
        const { rows } = await withActor(token, (tx) =>
          tx.query<Record<string, unknown>>(
            "SELECT outcome, institution_id, evidence_package_id, segment_hashes FROM app.read_process_summary_source($1)",
            [documentId],
          ),
        );
        const result = sourceResult(rows);
        if (result.status === "not_found" || result.status === "unauthenticated") {
          return { status: result.status };
        }
        return result;
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ZD401") {
          return { status: "unauthenticated" };
        }
        throw error;
      }
    },
  };
}
