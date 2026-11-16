// The descriptor of one accepted segment v2, as the commit RPC stores it.
// Ported from Ductus src/application/ports/evidence-ingest.ts at d52a92c3
// (type and isEvidenceSegmentDescriptorV2 only, without a change of logic) for
// the commit of the VS-1 narrow cut (DAN-815). The server builds it from the
// bytes it verified; this check is the last gate before the database.
import {
  EVIDENCE_CANONICALIZATION_V2,
  EVIDENCE_HASH_ALGORITHM_V2,
  type EvidenceSegmentSchema,
  exceedsEvidenceSegmentLimit,
  isEvidenceMinuteV2,
  isEvidenceSegmentSchema,
  MAX_EVIDENCE_PROFILE_ID_LENGTH,
} from "../forensics/index.ts";
import { hasOnlyKeys, isPlainObject } from "../json/index.ts";

import { isEvidencePackageId } from "./object-key.ts";

export type EvidenceSegmentDescriptorV2 = {
  evidencePackageId: string;
  documentId: string;
  sessionId: string;
  segmentId: string;
  /** The schema of the segment, v2 or v3 (contract #896). */
  evidenceSchema: EvidenceSegmentSchema;
  canonicalization: typeof EVIDENCE_CANONICALIZATION_V2;
  hashAlgorithm: typeof EVIDENCE_HASH_ALGORITHM_V2;
  evidenceProfileId: string;
  sequenceFrom: number;
  sequenceTo: number;
  eventCount: number;
  observedStartedAt: string;
  observedEndedAt: string;
  segmentHash: string;
  predecessorSegmentHash: string | null;
  payloadBytes: number;
};

const SHA256_HEX = /^[0-9a-f]{64}$/;
const MAX_ID_LENGTH = 256;
const DESCRIPTOR_KEYS: ReadonlySet<string> = new Set<keyof EvidenceSegmentDescriptorV2>([
  "evidencePackageId",
  "documentId",
  "sessionId",
  "segmentId",
  "evidenceSchema",
  "canonicalization",
  "hashAlgorithm",
  "evidenceProfileId",
  "sequenceFrom",
  "sequenceTo",
  "eventCount",
  "observedStartedAt",
  "observedEndedAt",
  "segmentHash",
  "predecessorSegmentHash",
  "payloadBytes",
]);

function nonEmptyBounded(value: unknown, max = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

export function isEvidenceSegmentDescriptorV2(
  descriptor: unknown,
): descriptor is EvidenceSegmentDescriptorV2 {
  if (!isPlainObject(descriptor)) return false;
  // Unknown fields fail closed so nothing unvalidated travels downstream.
  if (!hasOnlyKeys(descriptor, DESCRIPTOR_KEYS)) return false;
  return !(
    !isEvidencePackageId(descriptor.evidencePackageId) ||
    !nonEmptyBounded(descriptor.documentId) ||
    !nonEmptyBounded(descriptor.sessionId) ||
    !nonEmptyBounded(descriptor.segmentId) ||
    !isEvidenceSegmentSchema(descriptor.evidenceSchema) ||
    descriptor.canonicalization !== EVIDENCE_CANONICALIZATION_V2 ||
    descriptor.hashAlgorithm !== EVIDENCE_HASH_ALGORITHM_V2 ||
    !nonEmptyBounded(descriptor.evidenceProfileId, MAX_EVIDENCE_PROFILE_ID_LENGTH) ||
    !Number.isSafeInteger(descriptor.sequenceFrom) ||
    Number(descriptor.sequenceFrom) < 1 ||
    !Number.isSafeInteger(descriptor.sequenceTo) ||
    Number(descriptor.sequenceTo) < Number(descriptor.sequenceFrom) ||
    !Number.isSafeInteger(descriptor.eventCount) ||
    Number(descriptor.eventCount) < 1 ||
    // Counted as to - from, which is exact for safe integers: from + count - 1
    // can round in a double and pass a count the range does not hold.
    Number(descriptor.sequenceTo) - Number(descriptor.sequenceFrom) !==
      Number(descriptor.eventCount) - 1 ||
    // Whole minutes only (D-24): the descriptor repeats the times of the segment.
    !isEvidenceMinuteV2(descriptor.observedStartedAt) ||
    !isEvidenceMinuteV2(descriptor.observedEndedAt) ||
    Date.parse(descriptor.observedEndedAt) < Date.parse(descriptor.observedStartedAt) ||
    typeof descriptor.segmentHash !== "string" ||
    !SHA256_HEX.test(descriptor.segmentHash) ||
    !(
      descriptor.predecessorSegmentHash === null ||
      (typeof descriptor.predecessorSegmentHash === "string" &&
        SHA256_HEX.test(descriptor.predecessorSegmentHash))
    ) ||
    !Number.isSafeInteger(descriptor.payloadBytes) ||
    Number(descriptor.payloadBytes) < 1 ||
    exceedsEvidenceSegmentLimit(Number(descriptor.payloadBytes))
  );
}
