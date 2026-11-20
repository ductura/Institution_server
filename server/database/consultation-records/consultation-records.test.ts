// The consultation records port over a fake withActor: the statements and
// their parameters, the refusals as outcomes, every row checked. Every value is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";
import { createConsultationRecords, isCalendarDate, recordsOf } from "./consultation-records.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const DOCUMENT = "izmisljeni-rad-0001";
const R1 = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c11";
const R2 = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c12";
const A1 = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c21";
const MINUTE = new Date("2026-11-19T09:30:00.000Z");
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });

function fake(answer: unknown[] | Error) {
  const seen: { token: unknown; sql: string; values: readonly unknown[] }[] = [];
  const withActor = (async (token, fn) =>
    fn({
      async query(sql: string, values: readonly unknown[] = []) {
        seen.push({ token, sql, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer, rowCount: answer.length };
      },
    } as unknown as ActorTransaction)) as WithActor;
  return { port: createConsultationRecords(withActor), seen };
}

const row = (recordId: string, additionId: string | null = null) => ({
  recordId,
  heldOn: "2026-11-18",
  revision: "3",
  topic: "Izmišljena tema",
  agreement: "",
  additionId,
  additionBody: additionId === null ? null : "Dopuna.",
  additionMinute: additionId === null ? null : MINUTE,
});

describe("list", () => {
  it("groups the additions under their record, in the order of the rows", async () => {
    const { port, seen } = fake([
      row(R1, A1),
      row(R1, "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c22"),
      row(R2),
    ]);
    const answer = await port.list(TOKEN, DOCUMENT);
    expect(seen[0]?.sql).toContain("FROM collaboration.list_consultation_records($1)");
    expect(seen[0]?.values).toEqual([DOCUMENT]);
    expect(answer.status).toBe("ok");
    if (answer.status !== "ok") return;
    expect(answer.records.map((r) => [r.id, r.additions.length])).toEqual([
      [R1, 2],
      [R2, 0],
    ]);
    expect(answer.records[0]?.additions[0]).toEqual({
      id: A1,
      text: "Dopuna.",
      createdAt: "2026-11-19T09:30:00.000Z",
    });
    expect(answer.records[0]?.revision).toBe(3);
  });

  it("answers an empty list for a work with no record", async () => {
    expect(await fake([]).port.list(TOKEN, DOCUMENT)).toEqual({ status: "ok", records: [] });
  });

  it("turns the database refusals into outcomes and rethrows the rest", async () => {
    expect(await fake(coded("ZD401")).port.list(TOKEN, DOCUMENT)).toEqual({
      status: "unauthenticated",
    });
    expect(await fake(coded("ZD403")).port.list(TOKEN, DOCUMENT)).toEqual({ status: "not_found" });
    await expect(fake(coded("08006")).port.list(TOKEN, DOCUMENT)).rejects.toThrow();
  });

  it("vouches for no row it cannot check", () => {
    expect(recordsOf([{ ...row(R1), revision: "0" }])).toBeNull();
    expect(recordsOf([{ ...row(R1), heldOn: "2026-02-30" }])).toBeNull();
    expect(recordsOf([{ ...row(R1), recordId: "x" }])).toBeNull();
    expect(
      recordsOf([{ ...row(R1, A1), additionMinute: new Date("2026-11-19T09:30:01.000Z") }]),
    ).toBeNull();
  });
});

describe("create", () => {
  const input = { heldOn: "2026-11-18", revision: 3, topic: "Tema", agreement: "Dogovor." };

  it("asks create_consultation_record once and answers the record without additions", async () => {
    const { port, seen } = fake([{ id: R1 }]);
    expect(await port.create(TOKEN, DOCUMENT, input)).toEqual({
      status: "ok",
      record: { id: R1, ...input, additions: [] },
    });
    expect(seen[0]?.values).toEqual([DOCUMENT, "2026-11-18", 3, "Tema", "Dogovor."]);
  });

  it("refuses a date that does not exist before the database", async () => {
    const { port, seen } = fake([{ id: R1 }]);
    expect(await port.create(TOKEN, DOCUMENT, { ...input, heldOn: "2026-02-30" })).toEqual({
      status: "invalid_input",
    });
    expect(seen).toHaveLength(0);
  });

  it("maps ZD422 to invalid_input and ZD403 to not_found", async () => {
    expect((await fake(coded("ZD422")).port.create(TOKEN, DOCUMENT, input)).status).toBe(
      "invalid_input",
    );
    expect((await fake(coded("ZD403")).port.create(TOKEN, DOCUMENT, input)).status).toBe(
      "not_found",
    );
  });
});

describe("addAddition", () => {
  it("asks add_consultation_addition with the work, the record and the text", async () => {
    const { port, seen } = fake([{ id: A1, createdAt: MINUTE }]);
    expect(await port.addAddition(TOKEN, DOCUMENT, R1, "Dopuna.")).toEqual({
      status: "ok",
      addition: { id: A1, text: "Dopuna.", createdAt: "2026-11-19T09:30:00.000Z" },
    });
    expect(seen[0]?.values).toEqual([DOCUMENT, R1, "Dopuna."]);
  });

  it("is unavailable when the row is not what the function returns", async () => {
    expect((await fake([]).port.addAddition(TOKEN, DOCUMENT, R1, "x")).status).toBe("unavailable");
  });
});

describe("isCalendarDate", () => {
  it("accepts real days only", () => {
    expect(isCalendarDate("2028-02-29")).toBe(true);
    expect(isCalendarDate("2027-02-29")).toBe(false);
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("26-11-18")).toBe(false);
    expect(isCalendarDate(20261118)).toBe(false);
  });
});
