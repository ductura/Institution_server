// Public interface of evidence payload storage (S3, objects addressed by
// hash, never overwritten). Other areas import from here, never from the
// files next to it; outside `http` only with `import type` (the port types).
// Ported from Ductus src/adapters/evidence at d52a92c3 (S-0.19, DAN-732).
export {
  bindPayloadReader,
  type EvidencePayloadLocator,
  type EvidencePayloadPresence,
  type EvidencePayloadPresenceResult,
  type EvidencePayloadPutResult,
  type EvidencePayloadReader,
  type EvidencePayloadReadResult,
  type EvidencePayloadStore,
  type EvidenceStorageRefResult,
  type InstitutionEvidencePayloadReader,
} from "./port.ts";
export {
  EVIDENCE_STORAGE_DOMAINS,
  EvidenceStorageConfigError,
  loadEvidenceStorageConfig,
  type EvidenceStorageConfig,
  type EvidenceStorageDomain,
} from "./evidence-storage-config.ts";
export {
  MAX_S3_REQUEST_TIMEOUT_MS,
  S3EvidencePayloadStore,
  STORAGE_IDENTITY_KEY,
  type S3EvidencePayloadStoreConfig,
  type S3StorageCapability,
  type StorageIdentityResult,
} from "./s3-evidence-payload-store.ts";
export { S3SecretCredentials, type S3Credentials } from "./s3-signature.ts";
export {
  InstitutionRoutedPayloadStore,
  STORAGE_UNAVAILABLE,
  type DomainPayloadStore,
} from "./institution-routed-payload-store.ts";
export { InMemoryEvidencePayloadStore } from "./in-memory-evidence-payload-store.ts";
// The replayer of edit steps v1 that a submission reconstructs with (SRV-18);
// a test builds the hashes of its invented events with the same one.
export { createEditStepsV1Replayer } from "./edit-steps-v1-replayer.ts";
// SRV-1703: the comparison of a review reads records in document v3 too.
export { createEditStepsV3Replayer } from "./edit-steps-v2-replayer.ts";
