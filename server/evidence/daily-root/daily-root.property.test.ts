// Acceptance 3 (SRV-1311): property tests over random sequences of entries.
import { fc, test } from "@fast-check/vitest";
import { describe, expect } from "vitest";
import {
  dailyRootOf,
  readDailyRootEntries,
  verifyDailyRoot,
  type DailyRootEntry,
} from "./daily-root.ts";
import { createDailyRootService } from "./job.ts";
import { createFakeSigner, createFakeStore, DAY, INSTITUTION } from "./daily-root.fixture.ts";

const START = Date.parse(`${DAY}T00:00:00.000Z`);
const signal = new AbortController().signal;
const signer = createFakeSigner();

const entryArb = fc.record({
  receiptId: fc.stringMatching(/^[a-z0-9-]{1,24}$/),
  acceptedAt: fc
    .integer({ min: 0, max: 86_399_999 })
    .map((ms) => new Date(START + ms).toISOString()),
  digest: fc.stringMatching(/^[0-9a-f]{64}$/),
});
const listArb = fc.uniqueArray(entryArb, { selector: (e) => e.receiptId, maxLength: 40 });

async function sign(list: DailyRootEntry[]) {
  const service = createDailyRootService({
    institutionId: INSTITUTION,
    readEntries: async () => list,
    signer,
    store: createFakeStore(),
  });
  return service.build(DAY, signal);
}

describe("daily root properties", () => {
  test.prop([listArb, fc.integer()], { numRuns: 60 })(
    "any order of the same entries gives the same root",
    async (list, seed) => {
      const shuffled = [...list].sort(
        (a, b) => ((a.receiptId.length * 31 + seed) % 7) - ((b.receiptId.length * 31 + seed) % 7),
      );
      expect(await dailyRootOf(readDailyRootEntries(list)!)).toBe(
        await dailyRootOf(readDailyRootEntries(shuffled)!),
      );
    },
  );

  test.prop([listArb], { numRuns: 40 })(
    "the signed record verifies over its own entries",
    async (list) => {
      const { bytes } = await sign(list);
      expect(await verifyDailyRoot(bytes, [...list].reverse(), signer.publicKey)).toEqual({
        ok: true,
      });
    },
  );

  test.prop([listArb.filter((l) => l.length > 0), fc.nat(), fc.stringMatching(/^[0-9a-f]{64}$/)], {
    numRuns: 40,
  })("a changed digest fails", async (list, pick, digest) => {
    const index = pick % list.length;
    fc.pre(list[index]!.digest !== digest);
    const { bytes } = await sign(list);
    const changed = list.map((e, i) => (i === index ? { ...e, digest } : e));
    expect((await verifyDailyRoot(bytes, changed, signer.publicKey)).ok).toBe(false);
  });

  test.prop([listArb.filter((l) => l.length > 0), fc.nat()], { numRuns: 40 })(
    "a removed entry fails",
    async (list, pick) => {
      const { bytes } = await sign(list);
      const removed = list.filter((_, i) => i !== pick % list.length);
      expect((await verifyDailyRoot(bytes, removed, signer.publicKey)).ok).toBe(false);
    },
  );

  test.prop([listArb, entryArb], { numRuns: 40 })("an added entry fails", async (list, extra) => {
    fc.pre(!list.some((e) => e.receiptId === extra.receiptId));
    const { bytes } = await sign(list);
    expect((await verifyDailyRoot(bytes, [...list, extra], signer.publicKey)).ok).toBe(false);
  });

  test.prop([listArb], { numRuns: 20 })("another key fails", async (list) => {
    const { bytes } = await sign(list);
    expect(await verifyDailyRoot(bytes, list, createFakeSigner().publicKey)).toEqual({
      ok: false,
      problem: "signature_invalid",
    });
  });
});
