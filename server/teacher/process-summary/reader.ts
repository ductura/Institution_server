import { canonicalizeJcs, decodeStrictUtf8, type EvidenceSegment } from "../../domain/index.ts";
import type { InstitutionEvidencePayloadReader } from "../../external/storage/index.ts";
import type { ReadProcessSummary } from "../../http/index.ts";

import { processSummaryDetails, type ProcessSummaryV1 } from "./details.ts";

type ReadResult = Awaited<ReturnType<NonNullable<ReadProcessSummary>>>;

/** Use the exact payload bytes that the actor-bound summary reader verifies. */
export async function readProcessSummaryDetails(
  readSummary: (payloads: InstitutionEvidencePayloadReader) => Promise<ReadResult>,
  payloads: InstitutionEvidencePayloadReader,
): Promise<ReadResult> {
  const accepted: Uint8Array[] = [];
  const result = await readSummary({
    async readImmutable(locator) {
      const stored = await payloads.readImmutable(locator);
      if (stored.status !== "found") return stored;
      const bytes = new Uint8Array(stored.bytes);
      accepted.push(bytes);
      return { status: "found", bytes };
    },
  });
  if (result.status !== "ok") return result;

  const segments = accepted.map((bytes) => JSON.parse(decodeStrictUtf8(bytes)!) as EvidenceSegment);
  const summary = JSON.parse(result.body) as ProcessSummaryV1;
  return {
    status: "ok",
    body: canonicalizeJcs(processSummaryDetails(summary, segments)),
  };
}
