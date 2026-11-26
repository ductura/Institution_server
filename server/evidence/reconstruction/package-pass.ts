import type { InstitutionEvidencePayloadReader } from "../../external/storage/index.ts";
import {
  verifyCanonicalEvidencePayloadV2,
  verifyEvidenceChainV2,
  type AsyncEvidenceStepReplayerV2,
  type JcsJsonValue,
} from "../../domain/index.ts";
import type { VerifiedEvidenceSegment } from "./checkpoint.ts";
import type { WorkerEvidenceChainSource } from "./chain-source.ts";
import { recordDueCheckpoints } from "./service.ts";
import type { ReconstructionCheckpointStore } from "./store.ts";

/**
 * What the pass did for one package. Closed reasons only, so the worker's log
 * line carries counts and never an id or a text.
 *
 * - `recorded`: at least one checkpoint was written;
 * - `current`: nothing was missing (written by an earlier pass or a rival);
 * - `skipped`: the record is readable but no checkpoint can be taken from it
 *   (`broken_chain`, `gap`, `not_reproducible`, `unsupported_document`,
 *   `chain_too_long`, `no_chain`); a retry gives the same answer until the
 *   record changes;
 * - `unavailable`: a read or a write did not answer, a retry may succeed.
 */
export type PackagePassOutcome =
  | { status: "recorded"; written: number }
  | { status: "current" }
  | {
      status: "skipped";
      reason:
        | "no_chain"
        | "chain_too_long"
        | "broken_chain"
        | "gap"
        | "unsupported_document"
        | "not_reproducible";
    }
  | { status: "unavailable"; reason: string };

export type PackageCheckpointRecorder = {
  recordPackage(input: {
    evidencePackageId: string;
    institutionId: string;
  }): Promise<PackagePassOutcome>;
};

export type PackageCheckpointRecorderDeps<TDocument> = {
  source: Pick<WorkerEvidenceChainSource, "readChain">;
  /** The segment objects, by institution (the storage domain of the package). */
  payloads: InstitutionEvidencePayloadReader;
  store: ReconstructionCheckpointStore;
  /**
   * The replayer of a work whose revision 0 declares `schemaVersion`
   * (`null` when it declares none); `null` for a version this worker does not
   * replay, which leaves the package alone.
   */
  replayerFor(schemaVersion: number | null): AsyncEvidenceStepReplayerV2<TDocument> | null;
  interval?: number;
};

function parseInitialDocument(
  text: string,
): { document: JcsJsonValue; schemaVersion: number | null } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  return {
    document: parsed as JcsJsonValue,
    schemaVersion: typeof version === "number" && Number.isSafeInteger(version) ? version : null,
  };
}

/**
 * The write of one package's missing reconstruction checkpoints (SRV-1503,
 * M3.3): read its accepted chain, read every segment object from the
 * institution's storage, verify the bytes against the head the package
 * recorded, and only then replay the record and write what is due
 * (`recordDueCheckpoints`). The segments of a record that is broken, has a gap
 * or does not replay are never used for a checkpoint; and the database itself
 * refuses a text that is not the one the revision was committed with, so a
 * checkpoint is only ever a cache the record vouches for.
 */
export function createPackageCheckpointRecorder<TDocument>(
  deps: PackageCheckpointRecorderDeps<TDocument>,
): PackageCheckpointRecorder {
  const { source, payloads, store, replayerFor } = deps;
  return {
    async recordPackage({ evidencePackageId, institutionId }): Promise<PackagePassOutcome> {
      const read = await source
        .readChain(evidencePackageId)
        .catch(() => ({ status: "unavailable", reason: "source_failed" }) as const);
      if (read.status === "unavailable") return { status: "unavailable", reason: read.reason };
      if (read.status === "none") return { status: "skipped", reason: "no_chain" };
      const { chain } = read;
      if (chain.initialDocument === null)
        return { status: "skipped", reason: "unsupported_document" };
      const initial = parseInitialDocument(chain.initialDocument);
      const replayer = initial === null ? null : replayerFor(initial.schemaVersion);
      if (initial === null || replayer === null)
        return { status: "skipped", reason: "unsupported_document" };

      const bytes: Uint8Array[] = [];
      for (const segmentHash of chain.segmentHashes) {
        let object: Awaited<ReturnType<InstitutionEvidencePayloadReader["readImmutable"]>>;
        try {
          object = await payloads.readImmutable({ institutionId, evidencePackageId, segmentHash });
        } catch {
          return { status: "unavailable", reason: "storage_failed" };
        }
        if (object.status === "unavailable")
          return { status: "unavailable", reason: "storage_failed" };
        if (object.status === "not_found") return { status: "skipped", reason: "broken_chain" };
        // Copy once so the bytes that are verified are the bytes that are replayed.
        bytes.push(new Uint8Array(object.bytes));
      }

      const head = { segmentHash: chain.headSegmentHash, segmentCount: chain.segmentHashes.length };
      let verified: Awaited<ReturnType<typeof verifyEvidenceChainV2>>;
      try {
        verified = await verifyEvidenceChainV2(bytes, head);
      } catch {
        return { status: "skipped", reason: "broken_chain" };
      }
      if (!verified.ok) return { status: "skipped", reason: "broken_chain" };
      if (verified.discontinuities.length > 0) return { status: "skipped", reason: "gap" };

      const segments: VerifiedEvidenceSegment[] = [];
      for (const [index, payload] of bytes.entries()) {
        const segment = await verifyCanonicalEvidencePayloadV2(payload);
        // The object must be the one the database listed under that hash.
        if (!segment.ok || segment.sha256 !== chain.segmentHashes[index])
          return { status: "skipped", reason: "broken_chain" };
        segments.push({ segmentHash: segment.sha256, segment: segment.segment });
      }

      const recorded = await recordDueCheckpoints({
        store,
        evidencePackageId,
        initialDocument: initial.document,
        segments,
        replayer,
        ...(deps.interval === undefined ? {} : { interval: deps.interval }),
      });
      if (recorded.status === "not_reproducible")
        return { status: "skipped", reason: "not_reproducible" };
      if (recorded.status === "stopped") {
        return { status: "unavailable", reason: recorded.reason };
      }
      return recorded.recorded.length > 0
        ? { status: "recorded", written: recorded.recorded.length }
        : { status: "current" };
    },
  };
}
