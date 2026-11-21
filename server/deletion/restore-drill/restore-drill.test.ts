import { describe, expect, it } from "vitest";
import { createDeletionService, type ErasureTombstone } from "../index.ts";
import { createFakeSigner, createFakeStore, tombstone } from "./restore-drill.fixture.ts";
import { runRestoreDrill } from "./restore-drill.ts";

const SYNTHETIC = "5d5d5d5d-0000-4000-8000-000000000001";
const REAL_LOOKING = "0f0e0d0c-0b0a-4908-8706-050403020100";

function drillTombstone(seed: number): ErasureTombstone {
  return { ...tombstone(seed), institutionId: SYNTHETIC };
}

async function checkpointOf(records: ErasureTombstone[], institutionId = SYNTHETIC) {
  const signer = createFakeSigner();
  const built = await createDeletionService({
    signer,
    store: createFakeStore(),
  }).checkpointErasures({
    institutionId,
    records,
  });
  const key = await signer.publicVerificationKey();
  if (!built.ok || !key.ok) throw new Error("fake checkpoint failed");
  return { bytes: built.value.bytes, publicKey: key.value };
}

const TOMBSTONES = [drillTombstone(1), drillTombstone(2), drillTombstone(3)];
const ERASED = TOMBSTONES.map((t) => ({
  dataClass: t.dataClass,
  subjectId: t.subjectId,
  contentSha256: t.contentSha256,
}));
const KEPT = [
  { dataClass: "access_log" as const, subjectId: "subject-kept-a", contentSha256: "a".repeat(64) },
  { dataClass: "access_log" as const, subjectId: "subject-kept-b", contentSha256: "b".repeat(64) },
];

describe("restore drill (M10.Z1)", () => {
  it("opens the restore when the restored tombstones match the checkpoint", async () => {
    const { bytes, publicKey } = await checkpointOf(TOMBSTONES);
    const result = await runRestoreDrill({
      institutionId: SYNTHETIC,
      checkpoint: bytes,
      publicKey,
      tombstones: TOMBSTONES,
      copy: KEPT,
    });
    expect(result).toEqual({ ok: true, restore: "open", restored: KEPT, withheld: [] });
  });

  it("opens the restore for an empty record against an empty checkpoint", async () => {
    const { bytes, publicKey } = await checkpointOf([]);
    const result = await runRestoreDrill({
      institutionId: SYNTHETIC,
      checkpoint: bytes,
      publicKey,
      tombstones: [],
      copy: KEPT,
    });
    expect(result).toMatchObject({ ok: true, restore: "open", restored: KEPT });
  });

  describe("does not open the restore when the tombstones do not match", () => {
    const cases: [string, (all: ErasureTombstone[]) => ErasureTombstone[], string][] = [
      ["a tombstone missing", (all) => all.slice(0, 2), "count_mismatch"],
      ["a tombstone added", (all) => [...all, drillTombstone(9)], "count_mismatch"],
      ["tombstones reordered", (all) => [all[1]!, all[0]!, all[2]!], "chain_mismatch"],
      [
        "a tombstone changed",
        (all) => [all[0]!, { ...all[1]!, contentSha256: "c".repeat(64) }, all[2]!],
        "chain_mismatch",
      ],
    ];
    for (const [name, change, problem] of cases) {
      it(name, async () => {
        const { bytes, publicKey } = await checkpointOf(TOMBSTONES);
        const result = await runRestoreDrill({
          institutionId: SYNTHETIC,
          checkpoint: bytes,
          publicKey,
          tombstones: change(TOMBSTONES),
          copy: KEPT,
        });
        expect(result).toEqual({ ok: false, restore: "closed", problem });
      });
    }

    it("a checkpoint signed by another key", async () => {
      const { bytes } = await checkpointOf(TOMBSTONES);
      const other = await checkpointOf(TOMBSTONES);
      const result = await runRestoreDrill({
        institutionId: SYNTHETIC,
        checkpoint: bytes,
        publicKey: other.publicKey,
        tombstones: TOMBSTONES,
        copy: KEPT,
      });
      expect(result).toEqual({ ok: false, restore: "closed", problem: "signature_invalid" });
    });

    it("a checkpoint of another institution", async () => {
      const otherId = "5d5d5d5d-0000-4000-8000-000000000002";
      const other = TOMBSTONES.map((t) => ({ ...t, institutionId: otherId }));
      const { bytes, publicKey } = await checkpointOf(other, otherId);
      const result = await runRestoreDrill({
        institutionId: SYNTHETIC,
        checkpoint: bytes,
        publicKey,
        tombstones: TOMBSTONES,
        copy: KEPT,
      });
      expect(result.ok).toBe(false);
    });

    it("a malformed checkpoint", async () => {
      const { publicKey } = await checkpointOf(TOMBSTONES);
      const result = await runRestoreDrill({
        institutionId: SYNTHETIC,
        checkpoint: new Uint8Array([1, 2, 3]),
        publicKey,
        tombstones: TOMBSTONES,
        copy: KEPT,
      });
      expect(result).toEqual({ ok: false, restore: "closed", problem: "checkpoint_malformed" });
    });
  });

  it("does not bring an erased item back from the copy", async () => {
    const { bytes, publicKey } = await checkpointOf(TOMBSTONES);
    const result = await runRestoreDrill({
      institutionId: SYNTHETIC,
      checkpoint: bytes,
      publicKey,
      tombstones: TOMBSTONES,
      copy: [ERASED[0]!, KEPT[0]!, ERASED[2]!, KEPT[1]!],
    });
    expect(result).toEqual({
      ok: true,
      restore: "open",
      restored: KEPT,
      withheld: [ERASED[0], ERASED[2]],
    });
  });

  it("withholds an erased subject even when the copy holds other content for it", async () => {
    const { bytes, publicKey } = await checkpointOf(TOMBSTONES);
    const changed = { ...ERASED[1]!, contentSha256: "d".repeat(64) };
    const result = await runRestoreDrill({
      institutionId: SYNTHETIC,
      checkpoint: bytes,
      publicKey,
      tombstones: TOMBSTONES,
      copy: [changed],
    });
    expect(result).toMatchObject({ ok: true, restored: [], withheld: [changed] });
  });

  it("lets nothing through when the restore is closed", async () => {
    const { bytes, publicKey } = await checkpointOf(TOMBSTONES);
    const result = await runRestoreDrill({
      institutionId: SYNTHETIC,
      checkpoint: bytes,
      publicKey,
      tombstones: TOMBSTONES.slice(1),
      copy: [ERASED[0]!, ...KEPT],
    });
    expect(result).not.toHaveProperty("restored");
    expect(result).not.toHaveProperty("withheld");
  });

  it("accepts only an invented institution", async () => {
    const real = TOMBSTONES.map((t) => ({ ...t, institutionId: REAL_LOOKING }));
    const { bytes, publicKey } = await checkpointOf(real, REAL_LOOKING);
    for (const institutionId of [REAL_LOOKING, "not-a-uuid", 7, null, undefined]) {
      const result = await runRestoreDrill({
        institutionId,
        checkpoint: bytes,
        publicKey,
        tombstones: real,
        copy: KEPT,
      });
      expect(result).toEqual({ ok: false, restore: "closed", problem: "not_synthetic" });
    }
  });

  it("refuses malformed tombstones and a malformed copy with closed codes", async () => {
    const { bytes, publicKey } = await checkpointOf(TOMBSTONES);
    const base = { institutionId: SYNTHETIC, checkpoint: bytes, publicKey };
    expect(await runRestoreDrill({ ...base, tombstones: "x", copy: KEPT })).toEqual({
      ok: false,
      restore: "closed",
      problem: "records_malformed",
    });
    for (const copy of [
      "x",
      [null],
      [{ dataClass: "other" }],
      [{ ...KEPT[0]!, contentSha256: "z" }],
    ]) {
      expect(await runRestoreDrill({ ...base, tombstones: TOMBSTONES, copy })).toEqual({
        ok: false,
        restore: "closed",
        problem: "copy_malformed",
      });
    }
  });

  it("puts no input value into a refusal", async () => {
    const secret = "subject-secret-value";
    const result = await runRestoreDrill({
      institutionId: SYNTHETIC,
      checkpoint: new Uint8Array([0]),
      publicKey: null,
      tombstones: [],
      copy: [{ dataClass: "access_log", subjectId: secret, contentSha256: "e".repeat(64) }],
    });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
});
