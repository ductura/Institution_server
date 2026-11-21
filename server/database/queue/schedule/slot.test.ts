import { describe, expect, it } from "vitest";

import { parseJobBody } from "../../../domain/index.ts";

import { slotId, slotOf, slotStart } from "./slot.ts";

const DAY = 86_400_000;
const MIDNIGHT = Date.parse("2026-12-07T00:00:00.000Z");

describe("slots", () => {
  it("a slot starts on the grid of its period", () => {
    expect(slotStart(MIDNIGHT, DAY)).toBe(MIDNIGHT);
    expect(slotStart(MIDNIGHT + DAY - 1, DAY)).toBe(MIDNIGHT);
    expect(slotStart(MIDNIGHT + DAY, DAY)).toBe(MIDNIGHT + DAY);
  });

  it("an id is a lower-case UUIDv7 that carries the start and passes the job body guard", () => {
    const id = slotId("purge_ended_sessions", MIDNIGHT);
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(parseInt(id.slice(0, 8) + id.slice(9, 13), 16)).toBe(MIDNIGHT);
    expect(parseJobBody({ slotId: id }, ["slotId"]).ok).toBe(true);
  });

  it("one job and one start give one id; another job or start gives another", () => {
    const id = slotId("purge_ended_sessions", MIDNIGHT);
    expect(slotId("purge_ended_sessions", MIDNIGHT)).toBe(id);
    expect(slotId("daily_root", MIDNIGHT)).not.toBe(id);
    expect(slotId("purge_ended_sessions", MIDNIGHT + DAY)).not.toBe(id);
  });

  it("reads the start back only for the job the id was made for", () => {
    const id = slotId("purge_ended_sessions", MIDNIGHT);
    expect(slotOf("purge_ended_sessions", id)).toBe(MIDNIGHT);
    expect(slotOf("daily_root", id)).toBeNull();
  });

  it.each([
    ["a v4 uuid", "00000000-0000-4000-8000-000000000001"],
    ["upper case", slotId("purge_ended_sessions", MIDNIGHT).toUpperCase()],
    [
      "one changed hash digit",
      slotId("purge_ended_sessions", MIDNIGHT).replace(/.$/, (c) => (c === "0" ? "1" : "0")),
    ],
    [
      "a changed start",
      `${slotId("purge_ended_sessions", MIDNIGHT + 1).slice(0, 13)}${slotId("purge_ended_sessions", MIDNIGHT).slice(13)}`,
    ],
    ["text", "synthetic text"],
  ])("refuses %s", (_label, id) => {
    expect(slotOf("purge_ended_sessions", id)).toBeNull();
  });

  it.each([[-1], [1.5], [2 ** 48], [Number.NaN]])("refuses the start %s", (start) => {
    expect(() => slotId("purge_ended_sessions", start)).toThrow(
      new RangeError("slot_out_of_range"),
    );
  });
});
