import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createFakeSigner,
  INSTITUTION_A,
  tombstone,
  type FakeSigner,
} from "./checkpoint.fixture.ts";
import {
  encodeErasureCheckpoint,
  erasureCheckpointPayload,
  erasureCheckpointSigningInput,
  verifyErasureCheckpoint,
  type ErasureTombstone,
} from "./erasure-checkpoint.ts";
import type { PublicVerificationKey } from "../domain/index.ts";

let signer: FakeSigner;
let publicKey: PublicVerificationKey;

beforeAll(async () => {
  signer = createFakeSigner();
  const key = await signer.publicVerificationKey();
  if (!key.ok) throw new Error("fake signer has no key");
  publicKey = key.value;
});

async function checkpointBytes(records: ErasureTombstone[]): Promise<Uint8Array> {
  const payload = await erasureCheckpointPayload(INSTITUTION_A, records);
  const signature = await signer.sign(erasureCheckpointSigningInput(payload));
  if (!signature.ok) throw new Error("fake signer failed");
  return encodeErasureCheckpoint({ payload, signature: signature.value });
}

// Distinct seeds give distinct invented tombstones of one institution.
const records = fc
  .uniqueArray(fc.integer({ min: 0, max: 50_000 }), { minLength: 0, maxLength: 12 })
  .map((seeds) => seeds.map((seed) => tombstone(seed)));
const nonEmpty = records.filter((list) => list.length > 0);
const RUNS = { numRuns: 60 };

describe("erasure checkpoint (property)", () => {
  it("verifies any run of records and gives the same bytes again", async () => {
    await fc.assert(
      fc.asyncProperty(records, async (list) => {
        const first = await checkpointBytes(list);
        const again = await checkpointBytes(list.map((record) => ({ ...record })));
        expect(again).toEqual(first);
        expect(await verifyErasureCheckpoint(first, list, publicKey)).toEqual({ ok: true });
      }),
      RUNS,
    );
  });

  it("fails when any one record is changed", async () => {
    await fc.assert(
      fc.asyncProperty(
        nonEmpty,
        fc.nat(),
        fc.integer({ min: 0, max: 15 }),
        async (list, pick, digit) => {
          const bytes = await checkpointBytes(list);
          const index = pick % list.length;
          const original = list[index]!;
          const hex = digit.toString(16);
          const replacement =
            original.contentSha256[0] === hex ? ((digit + 1) % 16).toString(16) : hex;
          const changed = list.map((record, at) =>
            at === index
              ? { ...record, contentSha256: replacement + record.contentSha256.slice(1) }
              : record,
          );
          expect(await verifyErasureCheckpoint(bytes, changed, publicKey)).toEqual({
            ok: false,
            problem: "chain_mismatch",
          });
        },
      ),
      RUNS,
    );
  });

  it("fails when any one record is left out", async () => {
    await fc.assert(
      fc.asyncProperty(nonEmpty, fc.nat(), async (list, pick) => {
        const bytes = await checkpointBytes(list);
        const shorter = list.filter((_, at) => at !== pick % list.length);
        expect(await verifyErasureCheckpoint(bytes, shorter, publicKey)).toMatchObject({
          ok: false,
        });
      }),
      RUNS,
    );
  });

  it("fails when the order changes", async () => {
    await fc.assert(
      fc.asyncProperty(
        records.filter((list) => list.length > 1),
        fc.nat(),
        fc.nat(),
        async (list, a, b) => {
          const from = a % list.length;
          let to = b % list.length;
          if (to === from) to = (from + 1) % list.length;
          const moved = [...list];
          const [record] = moved.splice(from, 1);
          moved.splice(to, 0, record!);
          const bytes = await checkpointBytes(list);
          expect(await verifyErasureCheckpoint(bytes, moved, publicKey)).toEqual({
            ok: false,
            problem: "chain_mismatch",
          });
        },
      ),
      RUNS,
    );
  });
});
