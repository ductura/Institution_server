import type { WithActor } from "../../../server/database/index.ts";

type SummaryRow = {
  outcome: "found" | "not_found" | "unavailable";
  institution_id: string;
  evidence_package_id: string;
  segment_hashes: string[];
};

export function processSummarySource(withActor: WithActor, token: string) {
  return {
    async readSource(documentId: string) {
      try {
        const { rows } = await withActor(token, (tx) =>
          tx.query<SummaryRow>(
            "SELECT outcome, institution_id, evidence_package_id, segment_hashes FROM app.read_process_summary_source($1)",
            [documentId],
          ),
        );
        const row = rows[0];
        if (row?.outcome === "not_found") return { status: "not_found" as const };
        if (rows.length !== 1 || row?.outcome !== "found") {
          return { status: "unavailable" as const, reason: "source_unavailable" };
        }
        const last = row.segment_hashes.at(-1);
        return {
          status: "found" as const,
          institutionId: row.institution_id,
          evidencePackageId: row.evidence_package_id,
          segmentHashes: row.segment_hashes,
          head:
            last === undefined
              ? null
              : { segmentHash: last, segmentCount: row.segment_hashes.length },
        };
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ZD401") {
          return { status: "unauthenticated" as const };
        }
        throw error;
      }
    },
  };
}
