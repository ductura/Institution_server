// Service of server/deletion (SRV-1302; plan M10.0-S1, D-272 MQ07): builds
// the signed checkpoint of the erasure record and stores it. The caller (the
// retention job of M10.0-S2, today `http` as the assembler) reads the
// tombstones through the database port and hands them over in order; this
// service reads no database and no clock. The signing port and the store
// are given by the assembler; tests give fakes.
import {
  canonicalizeJcs,
  type PublicVerificationKey,
  type Result,
  type SignatureEnvelope,
} from "../domain/index.ts";
import type { EvidencePayloadStore } from "../external/storage/index.ts";
import {
  encodeErasureCheckpoint,
  erasureCheckpointPayload,
  erasureCheckpointSigningInput,
  readErasureTombstones,
  sha256Hex,
  verifyErasureCheckpoint,
  type SignedErasureCheckpoint,
} from "./erasure-checkpoint.ts";

/**
 * The part of the signing port (`SigningKeyProvider` of `external/keys`) the
 * service needs; the port itself satisfies it. Typed here from `domain`, as
 * `deletion` does not import `external/keys` (docs/server-map.md §2).
 */
export type ErasureCheckpointSigner = {
  sign(message: Uint8Array): Promise<Result<SignatureEnvelope>>;
  publicVerificationKey(): Promise<Result<PublicVerificationKey>>;
};

/**
 * Checkpoints of one institution are one object each under
 * `v2/<institution>/erasure-checkpoint/<sha256>.json`: addressed by the hash
 * of their bytes, never overwritten, so storing the same checkpoint again is
 * `existing`. The real bucket of checkpoints is B0.1, not this service.
 */
export const ERASURE_CHECKPOINT_OBJECT_GROUP = "erasure-checkpoint";

export type ErasureCheckpointBuildProblem =
  | "institution_invalid"
  | "records_malformed"
  | "institution_mismatch"
  | "signing_unavailable"
  | "signer_not_ed25519"
  | "self_check_failed"
  | "storage_conflict"
  | "storage_invalid"
  | "storage_unavailable";

export type StoredErasureCheckpoint = {
  checkpoint: SignedErasureCheckpoint;
  bytes: Uint8Array<ArrayBuffer>;
  sha256: string;
  storageRef: string;
  stored: "stored" | "existing";
};

export type ErasureCheckpointBuild =
  | { ok: true; value: StoredErasureCheckpoint }
  | { ok: false; problem: ErasureCheckpointBuildProblem };

export type DeletionService = {
  /**
   * Signs and stores the checkpoint over `records` of `institutionId` in the
   * given order. Every record must be a tombstone of that institution. The
   * answer carries no input value; a problem is a closed code.
   */
  checkpointErasures(input: {
    institutionId: unknown;
    records: unknown;
  }): Promise<ErasureCheckpointBuild>;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function createDeletionService(deps: {
  signer: ErasureCheckpointSigner;
  store: EvidencePayloadStore;
}): DeletionService {
  return {
    async checkpointErasures(input) {
      const refuse = (problem: ErasureCheckpointBuildProblem): ErasureCheckpointBuild => ({
        ok: false,
        problem,
      });
      const institutionId = input.institutionId;
      if (typeof institutionId !== "string" || !UUID.test(institutionId))
        return refuse("institution_invalid");
      const records = readErasureTombstones(input.records);
      if (records === null) return refuse("records_malformed");
      if (records.some((record) => record.institutionId !== institutionId))
        return refuse("institution_mismatch");

      const payload = await erasureCheckpointPayload(institutionId, records);
      const signed = await deps.signer.sign(erasureCheckpointSigningInput(payload));
      if (!signed.ok) return refuse("signing_unavailable");
      if (signed.value.algorithm !== "Ed25519" || signed.value.signatureEncoding !== "raw") {
        return refuse("signer_not_ed25519");
      }
      const checkpoint: SignedErasureCheckpoint = { payload, signature: signed.value };
      const text = canonicalizeJcs(checkpoint);
      const bytes = encodeErasureCheckpoint(checkpoint);

      // A checkpoint is stored only once the key the port names verifies it
      // over the same records: a wrong key or a broken signer stores nothing.
      const key = await deps.signer.publicVerificationKey();
      if (!key.ok) return refuse("signing_unavailable");
      const check = await verifyErasureCheckpoint(bytes, records, key.value);
      if (!check.ok) return refuse("self_check_failed");

      const sha256 = sha256Hex(text);
      const put = await deps.store.putImmutable({
        institutionId,
        evidencePackageId: ERASURE_CHECKPOINT_OBJECT_GROUP,
        segmentHash: sha256,
        canonicalPayload: text,
      });
      switch (put.status) {
        case "stored":
        case "existing":
          return {
            ok: true,
            value: { checkpoint, bytes, sha256, storageRef: put.storageRef, stored: put.status },
          };
        case "conflict":
          return refuse("storage_conflict");
        case "invalid":
          return refuse("storage_invalid");
        case "unavailable":
          return refuse("storage_unavailable");
      }
    },
  };
}
