import { describe, expect, expectTypeOf, it } from "vitest";
import * as area from "./index.ts";
import type { DeletionService, ErasureCheckpointBuild } from "./index.ts";

describe("server/deletion public interface", () => {
  it("exports the empty routes and schemas, the checkpoint service and its verifier", () => {
    expect(Object.keys(area).sort()).toEqual([
      "DELETION_ROUTES",
      "DELETION_SCHEMAS",
      "ERASURE_CHAIN_GENESIS",
      "ERASURE_CHECKPOINT_FORMAT",
      "ERASURE_CHECKPOINT_OBJECT_GROUP",
      "ERASURE_DATA_CLASSES",
      "ERASURE_REASONS",
      "MAX_DRILL_COPY_ITEMS",
      "MAX_ERASURE_CHECKPOINT_BYTES",
      "MAX_ERASURE_CHECKPOINT_RECORDS",
      "SYNTHETIC_INSTITUTION_PATTERN",
      "createDeletionService",
      "readErasureTombstones",
      "runRestoreDrill",
      "verifyErasureCheckpoint",
    ]);
    expect(area.DELETION_ROUTES).toEqual([]);
    expect(area.DELETION_SCHEMAS).toEqual({});
  });

  it("has a service with the checkpoint method only", () => {
    expectTypeOf<keyof DeletionService>().toEqualTypeOf<"checkpointErasures">();
    expectTypeOf<ReturnType<DeletionService["checkpointErasures"]>>().toEqualTypeOf<
      Promise<ErasureCheckpointBuild>
    >();
  });
});
