// PIL-P1-RITAM-SRV, P-1 rule 4: the contracts of the rhythm of typing take and
// give gaps in milliseconds, at most 130 per burst, and the switch; never a
// key, a content or a measure derived from the gaps. All values are invented.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { ROUTES } from "../../contracts/index.ts";

const IDS = [
  "work.input-rhythm.post",
  "work.input-rhythm.get",
  "work.input-rhythm.delete",
  "work.input-rhythm-setting.get",
  "teacher.input-rhythm.get",
  "teacher.input-rhythm.put",
];
const routeOf = (id: string) => ROUTES.find((route) => route.id === id)!;
const FORBIDDEN =
  /key(code|stroke|name)?\b|"keys?"|speed|wpm|cpm|average|"mean"|median|"rate"|velocity|profile|stddev|variance|"content"/i;

describe("input rhythm contracts", () => {
  it("no request or answer names a key, a content or a derived measure", () => {
    for (const id of IDS) {
      const route = routeOf(id);
      expect(JSON.stringify([route.request, route.responses]), id).not.toMatch(FORBIDDEN);
    }
  });

  it("a burst is 1 to 130 whole gaps in milliseconds and nothing else", () => {
    const body = routeOf("work.input-rhythm.post").request.body!;
    expect(Value.Check(body, { gapsMs: [120, 80, 4000] })).toBe(true);
    expect(Value.Check(body, { gapsMs: Array(130).fill(5) })).toBe(true);
    expect(Value.Check(body, { gapsMs: Array(131).fill(5) })).toBe(false);
    expect(Value.Check(body, { gapsMs: [] })).toBe(false);
    expect(Value.Check(body, { gapsMs: [1.5] })).toBe(false);
    expect(Value.Check(body, { gapsMs: [5], keyCode: 65 })).toBe(false);
    expect(Value.Check(body, { gapsMs: [5], key: "a" })).toBe(false);
    expect(Value.Check(body, { gapsMs: ["a"] })).toBe(false);
  });

  it("the answers hold no key and no derived speed", () => {
    const bursts = routeOf("work.input-rhythm.get").responses[0]!.body!;
    const burst = {
      id: "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c51",
      gapsMs: [5],
      recordedAt: "2026-11-22T10:00:00.000Z",
    };
    expect(Value.Check(bursts, { bursts: [burst] })).toBe(true);
    expect(Value.Check(bursts, { bursts: [{ ...burst, keyCode: 65 }] })).toBe(false);
    expect(Value.Check(bursts, { bursts: [{ ...burst, speedWpm: 40 }] })).toBe(false);
    expect(Value.Check(bursts, { bursts: [burst], averageGapMs: 5 })).toBe(false);
    const recorded = routeOf("work.input-rhythm.post").responses[0]!.body!;
    expect(Value.Check(recorded, { recorded: true, speed: 1 })).toBe(false);
  });

  it("only the owner writes and only the teacher switches", () => {
    expect(routeOf("work.input-rhythm.post").access).toBe("student_owner");
    expect(routeOf("work.input-rhythm.delete").access).toBe("student_owner");
    expect(routeOf("work.input-rhythm-setting.get").method).toBe("GET");
    expect(routeOf("teacher.input-rhythm.put").access).toBe("course_teacher");
    expect(
      ROUTES.filter((route) => route.path.includes("input-rhythm") && route.method !== "GET").map(
        (route) => route.id,
      ),
    ).toEqual(["work.input-rhythm.post", "work.input-rhythm.delete", "teacher.input-rhythm.put"]);
  });
});
