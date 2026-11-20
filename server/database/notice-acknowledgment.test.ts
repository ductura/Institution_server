// The notice acknowledgment port over a fake withActor (Ductus
// acknowledgment-route.test.ts at 078c780, the database half): the RPC with
// the template version, the stored fingerprint in the same transaction, the
// rollback of another notice, and ZD409 told apart. All values are invented.
import { describe, expect, it } from "vitest";

import { createNoticeAcknowledgments } from "./notice-acknowledgment.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const ASSIGNMENT = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
const FP = "c4d5e6f7".repeat(8);
const AT = new Date("2026-11-16T07:45:12.345Z");
const INPUT = { assignmentId: ASSIGNMENT, versionNo: 2, fingerprint: FP, templateVersion: 1 };
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });

/** Each transaction answers its statements from `answers` in order; a throw rolls back. */
function fake(...answers: (unknown[] | Error)[]) {
  const seen: { tx: number; sql: string; values: readonly unknown[] }[] = [];
  const rolledBack: number[] = [];
  let transactions = 0;
  const withActor = (async (_token, fn) => {
    const tx = ++transactions;
    try {
      return await fn({
        async query(sql: string, values: readonly unknown[] = []) {
          seen.push({ tx, sql, values });
          const next = answers.shift() ?? [];
          if (next instanceof Error) throw next;
          return { rows: next, rowCount: next.length };
        },
      } as unknown as ActorTransaction);
    } catch (error) {
      rolledBack.push(tx);
      throw error;
    }
  }) as WithActor;
  return { port: createNoticeAcknowledgments(withActor), seen, rolledBack };
}

describe("acknowledge", () => {
  it("records with the template version and checks the stored fingerprint in one transaction", async () => {
    const { port, seen, rolledBack } = fake(
      [{ acknowledged_at: AT }],
      [{ notice_fingerprint: FP }],
    );
    expect(await port.acknowledge(TOKEN, INPUT)).toEqual({
      status: "acknowledged",
      acknowledgedAt: "2026-11-16T07:45:12.345Z",
    });
    expect(seen.map((s) => [s.tx, s.values])).toEqual([
      [1, [ASSIGNMENT, 2, 1]],
      [1, [ASSIGNMENT, 2]],
    ]);
    expect(seen[0]!.sql).toContain(
      "institution.acknowledge_notice($1::uuid, $2::integer, $3::integer)",
    );
    expect(seen[1]!.sql).toContain("student_id = app.current_user_id()");
    expect(rolledBack).toEqual([]);
  });

  it.each<[string, unknown[]]>([
    ["another fingerprint", [{ notice_fingerprint: "0".repeat(64) }]],
    ["no fingerprint (a row from before)", [{ notice_fingerprint: null }]],
    ["no stored row", []],
    ["two stored rows", [{ notice_fingerprint: FP }, { notice_fingerprint: FP }]],
  ])("%s is notice_changed and rolls back", async (_name, stored) => {
    const { port, rolledBack } = fake([{ acknowledged_at: AT }], stored);
    expect(await port.acknowledge(TOKEN, INPUT)).toEqual({ status: "notice_changed" });
    expect(rolledBack).toEqual([1]);
  });

  it("ZD409 with the version still current is notice_changed, otherwise conflict", async () => {
    let { port, seen } = fake(coded("ZD409"), [{ current_version: 2 }]);
    expect(await port.acknowledge(TOKEN, INPUT)).toEqual({ status: "notice_changed" });
    expect(seen[1]!).toMatchObject({ tx: 2, values: [ASSIGNMENT] });
    ({ port } = fake(coded("ZD409"), [{ current_version: 3 }]));
    expect(await port.acknowledge(TOKEN, INPUT)).toEqual({ status: "conflict" });
    ({ port } = fake(coded("ZD409"), coded("XX000")));
    expect(await port.acknowledge(TOKEN, INPUT)).toEqual({ status: "conflict" });
  });

  it.each([
    ["ZD401", { status: "unauthenticated" }],
    ["ZD403", { status: "forbidden" }],
    ["XX000", { status: "unavailable", reason: "database_error" }],
  ])("%s", async (code, expected) => {
    expect(await fake(coded(code)).port.acknowledge(TOKEN, INPUT)).toEqual(expected);
  });

  it("a time that is not a date is unavailable", async () => {
    const { port } = fake([{ acknowledged_at: "2026-11-16" }], [{ notice_fingerprint: FP }]);
    expect(await port.acknowledge(TOKEN, INPUT)).toEqual({
      status: "unavailable",
      reason: "row_malformed",
    });
  });
});
