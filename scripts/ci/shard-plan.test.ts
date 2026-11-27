import { describe, expect, it } from "vitest";
import { FILE_OVERHEAD_MS, plan, RESERVED_LOAD_MS } from "../../.github/workflows/index.ts";

const planner = plan;

const files = Array.from({ length: 60 }, (_, i) => `server/a${String(i).padStart(2, "0")}.test.ts`);
const timings = Object.fromEntries(files.map((file, i) => [file, ((i * 7919) % 5000) + 10]));
const load = (leg: string[], table: Record<string, number>) =>
  leg.reduce((sum, file) => sum + (table[file] ?? 0) + FILE_OVERHEAD_MS, 0);

describe("shard plan of the checks job", () => {
  it("puts every file on exactly one leg, with or without reserved legs", () => {
    for (const reserved of [[], [3, 4]]) {
      const legs = planner(files, timings, 4, reserved);
      expect(legs).toHaveLength(4);
      expect(legs.flat().sort()).toEqual([...files].sort());
    }
  });

  it("is deterministic, whatever the order of the listed files", () => {
    expect(planner([...files].reverse(), timings, 4, [3, 4])).toEqual(
      planner(files, timings, 4, [3, 4]),
    );
  });

  it("balances by time, not by count: one slow file does not share a leg with half the rest", () => {
    const skewed = { ...timings, [files[0] as string]: 200_000 };
    const legs = planner(files, skewed, 4);
    const slow = legs.find((leg) => leg.includes(files[0] as string)) as string[];
    expect(slow.length).toBeLessThan(files.length / 4);
    const loads = legs.map((leg) => load(leg, skewed));
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(200_000 + FILE_OVERHEAD_MS);
  });

  it("gives the legs that also run the property tests less work", () => {
    const legs = planner(files, timings, 4, [3, 4]);
    const [a, b, c, d] = legs.map((leg) => load(leg, timings)) as [number, number, number, number];
    expect(c + RESERVED_LOAD_MS).toBeGreaterThan(a - 5000);
    expect(c).toBeLessThan(a);
    expect(d).toBeLessThan(b);
  });

  it("still runs a file the timing table does not know, once", () => {
    const fresh = "server/brand-new.test.ts";
    const legs = planner([...files, fresh], timings, 4, [3, 4]);
    expect(legs.flat().filter((file) => file === fresh)).toHaveLength(1);
  });

  it("handles fewer files than legs and rejects a bad leg count", () => {
    expect(planner(files.slice(0, 2), timings, 4).flat().sort()).toEqual(files.slice(0, 2).sort());
    expect(() => planner(files, timings, 0)).toThrow();
  });
});
