import { describe, expect, it } from "vitest";

import { retentionReport } from "../../domain/index.ts";

import {
  classesAwaitingDecision,
  createRetentionDryRunReader,
  retentionPeriodStatus,
  withPeriodStatus,
} from "./index.ts";
import type { ActorTransaction, WithActor } from "../index.ts";

// SRV-ADMIN-3 (owner decision of 23. 11. 2026., item 5): a null period says
// why it is null, and no period is ever made up.
describe("retention period status", () => {
  it("the sessions are decided, the receipts are never deleted, every other class waits", () => {
    expect(
      withPeriodStatus(retentionReport(new Map())).map((entry) => [
        entry.key,
        entry.retentionDays,
        entry.periodStatus,
        entry.periodStatusKey,
      ]),
    ).toEqual([
      ["sessions", 30, "decided", "adminSettings.retentionPeriod.decided"],
      ["live-state", null, "awaiting_decision", "adminSettings.retentionPeriod.awaitingDecision"],
      ["versions", null, "awaiting_decision", "adminSettings.retentionPeriod.awaitingDecision"],
      ["change-times", null, "awaiting_decision", "adminSettings.retentionPeriod.awaitingDecision"],
      ["access-log", null, "awaiting_decision", "adminSettings.retentionPeriod.awaitingDecision"],
      ["receipts", null, "never_deleted", "adminSettings.retentionPeriod.neverDeleted"],
    ]);
  });

  it("names the classes that wait for the owner's decision (docs/contracts/admin-settings-v1.md)", () => {
    expect(classesAwaitingDecision()).toEqual([
      "live-state",
      "versions",
      "change-times",
      "access-log",
    ]);
  });

  it("a waiting class keeps a null period and an unknown class is an error, not a guess", () => {
    const report = withPeriodStatus(retentionReport(new Map()));
    for (const entry of report)
      if (entry.periodStatus !== "decided") expect(entry.retentionDays).toBeNull();
    const sessions = retentionReport(new Map())[0]!;
    expect(() => retentionPeriodStatus({ ...sessions, key: "grades" as "sessions" })).toThrow(
      "unknown class",
    );
  });

  it("the dry-run reader answers every class with its status", async () => {
    const withActor: WithActor = (_token, run) =>
      run({
        query: async () => ({ rows: [{ key: "sessions", candidates: 4 }] }),
      } as unknown as ActorTransaction);
    const read = await createRetentionDryRunReader(withActor)("T".repeat(43));
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.classes[0]).toMatchObject({
      key: "sessions",
      candidates: 4,
      periodStatus: "decided",
    });
    expect(read.classes.every((entry) => typeof entry.periodStatusKey === "string")).toBe(true);
  });
});
