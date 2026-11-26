import { describe, expect, it } from "vitest";

import * as reconstruction from "./index.ts";

describe("server/evidence/reconstruction public interface", () => {
  it("exports the checkpoint check, the read of a revision, the writer, the worker store and the worker's chain reads and package recorder, nothing else", () => {
    expect(Object.keys(reconstruction).sort()).toEqual([
      "MAX_CHAIN_BYTES",
      "MAX_CHAIN_SEGMENTS",
      "MAX_DUE_PACKAGES_PER_READ",
      "RECONSTRUCTION_CHECKPOINT_INTERVAL",
      "RECONSTRUCTION_CHECKPOINT_MAX_BYTES",
      "buildReconstructionCheckpoints",
      "checkpointRevisionsDue",
      "createPackageCheckpointRecorder",
      "createWorkerEvidenceChainSource",
      "createWorkerReconstructionCheckpointStore",
      "readDocumentAtRevision",
      "readPackageRevision",
      "recordDueCheckpoints",
      "verifyReconstructionCheckpoint",
    ]);
  });
});
