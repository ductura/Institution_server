import { describe, expect, it } from "vitest";

import { CSV_HEADER, parseFlags, SAMPLE_QUERIES, toCsvRow } from "./opt-1000-baza.ts";
import {
  buildMatrix,
  COPY_COUNTS,
  DRY_RUN_USERS,
  dryRun,
  forwardedFor,
  maxDurationSeconds,
} from "./opt-1000-plan.ts";
import { parseLoadFlags } from "./priprema.ts";

describe("buildMatrix", () => {
  it("has one run per load and copy count, web and worker scaled together", () => {
    const matrix = buildMatrix();
    expect(matrix).toHaveLength(2 * COPY_COUNTS.length);
    expect(matrix.map((run) => run.label)).toEqual([
      "pisci-w1-r1",
      "pisci-w2-r2",
      "pisci-w4-r4",
      "zahtjevi-w1-r1",
      "zahtjevi-w2-r2",
      "zahtjevi-w4-r4",
    ]);
    expect(matrix.filter((run) => run.load === "pisci").every((run) => run.rate === 0)).toBe(true);
    expect(matrix.filter((run) => run.load === "zahtjevi").every((run) => run.rate === 1000)).toBe(
      true,
    );
  });

  it("refuses more than 1000 users or requests a second, and nothing", () => {
    expect(() => buildMatrix(1001)).toThrow(RangeError);
    expect(() => buildMatrix(0)).toThrow(RangeError);
    expect(() => buildMatrix(1000, 1001)).toThrow(RangeError);
  });

  it("keeps the local dry run at 10 users on one copy", () => {
    expect(dryRun("pisci")).toMatchObject({ users: DRY_RUN_USERS, webCopies: 1, workerCopies: 1 });
  });
});

describe("forwardedFor", () => {
  it("gives every one of 1000 writers a distinct address", () => {
    const all = new Set(Array.from({ length: 1000 }, (_, i) => forwardedFor(i)));
    expect(all.size).toBe(1000);
    expect(forwardedFor(0)).toBe("10.0.0.1");
    expect(forwardedFor(256)).toBe("10.0.1.1");
  });

  it("refuses a negative or fractional index", () => {
    expect(() => forwardedFor(-1)).toThrow(RangeError);
    expect(() => forwardedFor(1.5)).toThrow(RangeError);
  });
});

describe("maxDurationSeconds", () => {
  it("grows with the saves and refuses none", () => {
    expect(maxDurationSeconds(20)).toBeGreaterThan(maxDurationSeconds(6));
    expect(() => maxDurationSeconds(0)).toThrow(RangeError);
  });
});

describe("database sampler", () => {
  it("writes a row with as many columns as the header", () => {
    const row = toCsvRow({
      second: 5,
      connections: 20,
      active: 3,
      waiting: 0,
      commits: 100,
      rollbacks: 1,
      queued: 7,
      activeJobs: 2,
      oldestQueuedSeconds: 4,
    });
    expect(row.split(",")).toHaveLength(CSV_HEADER.split(",").length);
  });

  it("runs only SELECTs", () => {
    for (const query of Object.values(SAMPLE_QUERIES))
      expect(query.trimStart().toUpperCase().startsWith("SELECT")).toBe(true);
  });

  it("needs the variable name and a label, and refuses a URL in the argument", () => {
    expect(() => parseFlags(["--oznaka=a"])).toThrow();
    expect(() => parseFlags(["--baza-env=postgres://u:p@h/db", "--oznaka=a"])).toThrow();
    expect(parseFlags(["--baza-env=MJERENJE_DATABASE_URL", "--oznaka=pisci-w1-r1"])).toMatchObject({
      intervalS: 5,
      durationS: 600,
    });
  });
});

describe("priprema --velicina", () => {
  it("accepts a document size up to 2000 and refuses more", () => {
    expect(parseLoadFlags(["--pokret=a1", "--velicina=1500"]).size).toBe(1500);
    expect(parseLoadFlags(["--pokret=a1"]).size).toBe(0);
    expect(() => parseLoadFlags(["--pokret=a1", "--velicina=2001"])).toThrow();
  });
});
