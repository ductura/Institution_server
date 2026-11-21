// Public interface of server/deletion; other areas import only this file.
export { DELETION_ROUTES } from "./routes.ts";
export { DELETION_SCHEMAS } from "./schemas.ts";
export {
  ERASURE_CHAIN_GENESIS,
  ERASURE_CHECKPOINT_FORMAT,
  ERASURE_DATA_CLASSES,
  ERASURE_REASONS,
  MAX_ERASURE_CHECKPOINT_BYTES,
  MAX_ERASURE_CHECKPOINT_RECORDS,
  verifyErasureCheckpoint,
  type ErasureCheckpointPayload,
  type ErasureCheckpointProblem,
  type ErasureCheckpointVerification,
  type ErasureDataClass,
  type ErasureReason,
  type ErasureTombstone,
  type SignedErasureCheckpoint,
} from "./erasure-checkpoint.ts";
export {
  createDeletionService,
  ERASURE_CHECKPOINT_OBJECT_GROUP,
  type DeletionService,
  type ErasureCheckpointBuild,
  type ErasureCheckpointBuildProblem,
  type ErasureCheckpointSigner,
  type StoredErasureCheckpoint,
} from "./service.ts";
