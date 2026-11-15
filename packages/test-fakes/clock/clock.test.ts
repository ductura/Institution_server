import { describe, expect, it } from "vitest";

import { createFakeClock } from "./index.ts";

// Resolves to whether the promise has settled after pending microtasks ran.
async function settled(promise: Promise<unknown>): Promise<boolean> {
  let done = false;
  promise.then(
    () => (done = true),
    () => (done = true),
  );
  await new Promise((resolve) => setImmediate(resolve));
  return done;
}

describe("fake clock", () => {
  it("starts where it is told and moves only with advance", () => {
    const clock = createFakeClock("2026-11-15T10:00:00.000Z");
    expect(clock.now().toISOString()).toBe("2026-11-15T10:00:00.000Z");
    clock.advance(1500);
    expect(clock.nowMs()).toBe(Date.parse("2026-11-15T10:00:01.500Z"));
    expect(createFakeClock(0).nowMs()).toBe(0);
  });

  it("wakes a sleeper exactly at its deadline, not before", async () => {
    const clock = createFakeClock();
    const sleep = clock.sleep(1000);
    clock.advance(999);
    expect(await settled(sleep)).toBe(false);
    clock.advance(1);
    expect(await settled(sleep)).toBe(true);
  });

  it("wakes several sleepers in deadline order on one advance", async () => {
    const clock = createFakeClock();
    const order: number[] = [];
    const sleeps = [300, 100, 200].map((ms) => clock.sleep(ms).then(() => order.push(ms)));
    clock.advance(1000);
    await Promise.all(sleeps);
    expect(order).toEqual([100, 200, 300]);
  });

  it("resolves a zero sleep at once", async () => {
    expect(await settled(createFakeClock().sleep(0))).toBe(true);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])("refuses to move by %s", (ms) => {
    const clock = createFakeClock();
    expect(() => clock.advance(ms)).toThrow(RangeError);
    expect(() => clock.sleep(ms)).toThrow(RangeError);
    expect(clock.nowMs()).toBe(createFakeClock().nowMs());
  });

  it("refuses an invalid start", () => {
    expect(() => createFakeClock("not a date")).toThrow(RangeError);
  });

  it("rejects an aborted sleep and does not wake it later", async () => {
    const clock = createFakeClock();
    const controller = new AbortController();
    const sleep = clock.sleep(1000, controller.signal);
    controller.abort();
    await expect(sleep).rejects.toMatchObject({ name: "AbortError" });
    clock.advance(2000);
    await expect(clock.sleep(1, AbortSignal.abort())).rejects.toMatchObject({
      name: "AbortError",
    });
  });
});
