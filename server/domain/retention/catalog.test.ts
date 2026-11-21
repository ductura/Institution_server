import { describe, expect, it } from "vitest";

import {
  RETENTION_CATALOG,
  RETENTION_CLASS_KEYS,
  retentionMode,
  retentionReport,
  type RetentionClass,
} from "./catalog.ts";

describe("retention catalogue (SRV-1304)", () => {
  it("has each class once, in the order of the keys", () => {
    expect(RETENTION_CATALOG.map((entry) => entry.key)).toEqual([...RETENTION_CLASS_KEYS]);
  });

  it("labels every class with a retention message key", () => {
    for (const entry of RETENTION_CATALOG) expect(entry.label).toMatch(/^retention\.[a-zA-Z]+$/);
  });

  it("decides only the sessions period (D-273 MQ08); every other period waits for D-30", () => {
    const periods = Object.fromEntries(RETENTION_CATALOG.map((e) => [e.key, e.retentionDays]));
    expect(periods).toEqual({
      sessions: 30,
      "live-state": null,
      versions: null,
      "change-times": null,
      "access-log": null,
      receipts: null,
    });
  });

  it("runs every class with a null period as a dry run", () => {
    for (const entry of RETENTION_CATALOG.filter((e) => e.retentionDays === null)) {
      expect(entry.mode).toBe("dry-run");
      expect(retentionMode(entry)).toBe("dry-run");
    }
  });

  it("keeps a null period a dry run even if an entry claimed execute", () => {
    // The type refuses it; a cast stands for a catalogue edited past the type.
    const forced = { ...RETENTION_CATALOG[1]!, mode: "execute" } as unknown as RetentionClass;
    expect(retentionMode(forced)).toBe("dry-run");
    const literal = { ...RETENTION_CATALOG[1]!, retentionDays: null, mode: "execute" } as const;
    // @ts-expect-error a null period cannot be paired with execute
    const typed: RetentionClass = literal;
    expect(retentionMode(typed)).toBe("dry-run");
  });

  it("never deletes hashes and receipts (class 27), whatever their period", () => {
    const receipts = RETENTION_CATALOG.find((e) => e.key === "receipts")!;
    expect(receipts.erasable).toBe(false);
    expect(receipts.dataClasses).toEqual([27]);
    expect(retentionMode({ ...receipts, retentionDays: 10, mode: "execute" })).toBe("dry-run");
    expect(RETENTION_CATALOG.filter((e) => !e.erasable).map((e) => e.key)).toEqual(["receipts"]);
  });
});

describe("retentionReport", () => {
  const counts = new Map<string, number | null>([
    ["sessions", 2],
    ["live-state", 1],
    ["versions", 3],
    ["change-times", null],
    ["access-log", 3],
  ]);

  it("reports every class with its count, null receipts and no last run", () => {
    expect(retentionReport(counts)).toEqual([
      {
        key: "sessions",
        label: "retention.sessions",
        retentionDays: 30,
        mode: "execute",
        candidates: 2,
        lastRunAt: null,
      },
      {
        key: "live-state",
        label: "retention.liveState",
        retentionDays: null,
        mode: "dry-run",
        candidates: 1,
        lastRunAt: null,
      },
      {
        key: "versions",
        label: "retention.versions",
        retentionDays: null,
        mode: "dry-run",
        candidates: 3,
        lastRunAt: null,
      },
      {
        key: "change-times",
        label: "retention.changeTimes",
        retentionDays: null,
        mode: "dry-run",
        candidates: null,
        lastRunAt: null,
      },
      {
        key: "access-log",
        label: "retention.accessLog",
        retentionDays: null,
        mode: "dry-run",
        candidates: 3,
        lastRunAt: null,
      },
      {
        key: "receipts",
        label: "retention.receipts",
        retentionDays: null,
        mode: "dry-run",
        candidates: null,
        lastRunAt: null,
      },
    ]);
  });

  it("does not count receipts even when a count arrives for them", () => {
    const report = retentionReport(new Map([["receipts", 7]]));
    expect(report.find((e) => e.key === "receipts")!.candidates).toBeNull();
  });

  it("gives null to a class without a count", () => {
    expect(retentionReport(new Map()).every((e) => e.candidates === null)).toBe(true);
  });

  it("refuses an unknown class and an invalid count", () => {
    expect(() => retentionReport(new Map([["grades", 1]]))).toThrow("unknown class");
    for (const bad of [-1, 1.5, Number.NaN, 2 ** 53]) {
      expect(() => retentionReport(new Map([["sessions", bad]]))).toThrow("invalid count");
    }
  });
});
