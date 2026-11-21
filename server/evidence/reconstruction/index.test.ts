import { describe, expect, it } from "vitest";

import * as reconstruction from "./index.ts";

describe("server/evidence/reconstruction public interface", () => {
  it("exports the checkpoint check, the read of a revision, the writer and the worker store, nothing else", () => {
    expect(Object.keys(reconstruction).sort()).toEqual([
      "RECONSTRUCTION_CHECKPOINT_INTERVAL",
      "RECONSTRUCTION_CHECKPOINT_MAX_BYTES",
      "buildReconstructionCheckpoints",
      "checkpointRevisionsDue",
      "createWorkerReconstructionCheckpointStore",
      "readDocumentAtRevision",
      "readPackageRevision",
      "recordDueCheckpoints",
      "verifyReconstructionCheckpoint",
    ]);
  });
});
