import { describe, expect, it } from "vitest";

import { REVISION_ZERO_JCS, REVISION_ZERO_SHA256 } from "../../../server/domain/index.ts";
import type { OpenedWork } from "../index.ts";

import {
  CHARS_PER_SAVE,
  OUTAGE,
  saveTimes,
  sentence,
  simulateHour,
  summarize,
} from "./sat-pisanja.ts";

const work: OpenedWork = {
  documentId: "11111111-1111-4111-8111-111111111111",
  document: Buffer.from(REVISION_ZERO_JCS, "utf8").toString("base64"),
  documentHash: REVISION_ZERO_SHA256,
  evidenceProfileId: "22222222-2222-4222-8222-222222222222",
};
const minute = "2026-11-26T10:00:00.000Z";

describe("sat pisanja", () => {
  it("types exactly the assumed number of characters per save", () => {
    for (const index of [0, 9, 99, 999]) expect(sentence(index)).toHaveLength(CHARS_PER_SAVE);
  });

  it("repeats exactly for the same seed and differs for another", () => {
    expect(saveTimes(1)).toEqual(saveTimes(1));
    expect(saveTimes(1)).not.toEqual(saveTimes(2));
  });

  it("saves only while writing, never during a rest", () => {
    for (const time of saveTimes(1)) {
      expect(time < 600 || (time >= 900 && time < 3000)).toBe(true);
    }
  });

  it("counts every save once and signs each one", () => {
    const counts = simulateHour(work, minute);
    expect(counts.saveRequests).toBe(counts.saves);
    expect(counts.signedReceipts).toBe(counts.saves);
    expect(counts.saves).toBeGreaterThan(100);
  });

  it("sends the whole snapshot with every save, so the long document costs far more", () => {
    const counts = simulateHour(work, minute);
    expect(counts.maxSaveBodyBytes).toBeGreaterThan(20 * counts.minSaveBodyBytes);
  });

  it("retries with backoff during the outage instead of one request a second", () => {
    const counts = simulateHour(work, minute);
    const outageSeconds = OUTAGE[1] - OUTAGE[0];
    expect(counts.liveFailed).toBeGreaterThan(0);
    expect(counts.liveFailed).toBeLessThan(outageSeconds / 2);
  });

  it("answers an unchanged live view with 304", () => {
    const counts = simulateHour(work, minute);
    expect(counts.liveGet304).toBeGreaterThan(counts.liveGet200);
    expect(summarize(counts)).toMatch(
      /^jedan sat ovakvog pisanja stvara \d+ zahtjeva, [\d.]+ MB prometa, \d+ potpisa$/,
    );
  });
});
