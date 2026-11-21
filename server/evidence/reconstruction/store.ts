import { isEvidenceDomainId } from "../../domain/index.ts";
import {
  RECONSTRUCTION_CHECKPOINT_MAX_BYTES,
  type ReconstructionCheckpoint,
} from "./checkpoint.ts";

/**
 * One statement on the worker's connection (ductus_worker), as the checkpoint
 * reader of M3.3-P03 takes it: no pool, no session, no principal.
 */
export type WorkerReconstructionQuery = (
  text: string,
  values: readonly unknown[],
) => Promise<{ rows: readonly unknown[] }>;

export type CheckpointStoreFault =
  "invalid_checkpoint_request" | "invalid_checkpoint_row" | "checkpoints_failed";

export type CheckpointReadResult =
  | { status: "found"; checkpoint: ReconstructionCheckpoint }
  | { status: "none" }
  | { status: "unavailable"; reason: CheckpointStoreFault };

export type CheckpointRecordResult =
  | { status: "recorded" | "exists" | "not_found" | "mismatch" }
  | { status: "unavailable"; reason: CheckpointStoreFault };

/** The reconstruction checkpoints of the worker's own evidence domain (SRV-1503). */
export type ReconstructionCheckpointStore = {
  /** The newest checkpoint of the package at or before `revision`. */
  readAtOrBefore(input: {
    evidencePackageId: string;
    revision: number;
  }): Promise<CheckpointReadResult>;
  /** Appends one checkpoint; the first one of a revision stays. */
  record(input: {
    evidencePackageId: string;
    checkpoint: ReconstructionCheckpoint;
  }): Promise<CheckpointRecordResult>;
};

// The columns come back under camelCase aliases, so no snake_case name
// reaches this code (CODE_STYLE 9).
const READ_SQL =
  'SELECT revision::text AS "revision", segment_hash AS "segmentHash", content_hash AS "contentHash", body' +
  " FROM app.worker_reconstruction_checkpoint($1::uuid, $2, $3::bigint)";
const RECORD_SQL =
  'SELECT app.worker_record_reconstruction_checkpoint($1::uuid, $2, $3::bigint, $4, $5) AS "outcome"';

// The package id and hash formats of the evidence schema (evidence.package.id,
// evidence.reconstruction_checkpoint), checked before any statement is sent.
const PACKAGE_ID = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const isEvidencePackageId = (value: unknown): value is string =>
  typeof value === "string" && PACKAGE_ID.test(value);
const isSha256Hex = (value: unknown): value is string =>
  typeof value === "string" && SHA256_HEX.test(value);

const RECORD_OUTCOMES = new Set(["recorded", "exists", "not_found", "mismatch"]);
const unavailable = (reason: CheckpointStoreFault) => ({ status: "unavailable", reason }) as const;
const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const exactKeys = (row: unknown, keys: readonly string[]): row is Record<string, unknown> =>
  typeof row === "object" &&
  row !== null &&
  Object.keys(row).length === keys.length &&
  keys.every((key) => Object.hasOwn(row, key));

function toCheckpoint(row: unknown, asked: number): ReconstructionCheckpoint | null {
  if (!exactKeys(row, ["revision", "segmentHash", "contentHash", "body"])) return null;
  const { revision, segmentHash, contentHash, body } = row;
  if (typeof revision !== "string" || !/^[1-9][0-9]{0,15}$/.test(revision)) return null;
  const number = Number(revision);
  if (!isRevision(number) || number > asked) return null;
  if (!isSha256Hex(segmentHash) || !isSha256Hex(contentHash)) return null;
  if (typeof body !== "string" || body.length === 0) return null;
  if (new TextEncoder().encode(body).byteLength > RECONSTRUCTION_CHECKPOINT_MAX_BYTES) return null;
  return { revision: number, segmentHash, contentHash, body };
}

/**
 * The worker's store of reconstruction checkpoints, through
 * `app.worker_reconstruction_checkpoint` and
 * `app.worker_record_reconstruction_checkpoint`. The domain is the worker's
 * configuration, never a request field. A read answer it cannot take whole
 * (more than one row, a row of another shape, a revision after the asked one)
 * is `unavailable`, never a partial checkpoint; every fault has a closed
 * reason and no driver text, which can carry an id or a body. The read
 * checkpoint is still verified before use (readDocumentAtRevision).
 */
export function createWorkerReconstructionCheckpointStore(options: {
  query: WorkerReconstructionQuery;
  evidenceDomainId: string;
}): ReconstructionCheckpointStore {
  const { query, evidenceDomainId } = options;
  const validRequest = (evidencePackageId: string, revision: number) =>
    isEvidenceDomainId(evidenceDomainId) &&
    isEvidencePackageId(evidencePackageId) &&
    isRevision(revision);

  return {
    async readAtOrBefore({ evidencePackageId, revision }): Promise<CheckpointReadResult> {
      if (!validRequest(evidencePackageId, revision))
        return unavailable("invalid_checkpoint_request");
      let rows: unknown;
      try {
        rows = (await query(READ_SQL, [evidenceDomainId, evidencePackageId, String(revision)]))
          ?.rows;
      } catch {
        return unavailable("checkpoints_failed");
      }
      if (!Array.isArray(rows) || rows.length > 1) return unavailable("invalid_checkpoint_row");
      if (rows.length === 0) return { status: "none" };
      const checkpoint = toCheckpoint(rows[0], revision);
      return checkpoint === null
        ? unavailable("invalid_checkpoint_row")
        : { status: "found", checkpoint };
    },

    async record({ evidencePackageId, checkpoint }): Promise<CheckpointRecordResult> {
      const { revision, segmentHash, body } = checkpoint;
      if (
        !validRequest(evidencePackageId, revision) ||
        !isSha256Hex(segmentHash) ||
        typeof body !== "string" ||
        body.length === 0 ||
        new TextEncoder().encode(body).byteLength > RECONSTRUCTION_CHECKPOINT_MAX_BYTES
      ) {
        return unavailable("invalid_checkpoint_request");
      }
      let rows: unknown;
      try {
        rows = (
          await query(RECORD_SQL, [
            evidenceDomainId,
            evidencePackageId,
            String(revision),
            segmentHash,
            body,
          ])
        )?.rows;
      } catch {
        return unavailable("checkpoints_failed");
      }
      if (!Array.isArray(rows) || rows.length !== 1 || !exactKeys(rows[0], ["outcome"]))
        return unavailable("invalid_checkpoint_row");
      const outcome = rows[0].outcome;
      if (typeof outcome !== "string" || !RECORD_OUTCOMES.has(outcome))
        return unavailable("invalid_checkpoint_row");
      return { status: outcome as "recorded" | "exists" | "not_found" | "mismatch" };
    },
  };
}
