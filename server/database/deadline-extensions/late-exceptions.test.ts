// SRV-NF4-IZNIMKA-ZAPIS: the port of late-submission exceptions over a fake
// withActor. The input is checked before the database, the written row is
// confirmed inside the transaction, and ZD401, ZD403 and ZD422 are outcomes.
// Every id and date below is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createLateExceptions } from "./late-exceptions.ts";

const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const S = "00000000-0000-4000-8000-0000000000e1";
const T = "00000000-0000-4000-8000-0000000000c1";
const E = "00000000-0000-4000-8000-0000000000f1";
const UNTIL = "2026-12-27T23:00:00.000Z";
const AT = new Date("2026-11-21T09:15:00.000Z");

const row = (over: Record<string, unknown> = {}) => ({
  id: E,
  studentId: S,
  untilAt: new Date(UNTIL),
  reasonId: "justified",
  createdBy: T,
  createdAt: AT,
  ...over,
});

function port(answer: unknown) {
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { port: createLateExceptions(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });
const input = { assignmentId: A, studentId: S, untilAt: UNTIL, reasonId: "justified" };

describe("grantLateException", () => {
  it("refuses bad input before the database", async () => {
    for (const bad of [
      { ...input, assignmentId: "nije-uuid" },
      { ...input, studentId: "NIJE" },
      { ...input, untilAt: "2026-12-27" },
      { ...input, untilAt: "2026-02-30T00:00:00.000Z" },
      { ...input, reasonId: "drugo" },
      { ...input, reasonId: "all" },
    ]) {
      const { port: p, seen } = port([row()]);
      expect(await p.grantLateException(TOKEN, bad)).toEqual({ status: "invalid_input" });
      expect(seen).toEqual([]);
    }
  });

  it("records the exception and reads the row back", async () => {
    const { port: p, seen } = port([row()]);
    expect(await p.grantLateException(TOKEN, input)).toEqual({
      status: "granted",
      exception: {
        id: E,
        studentId: S,
        untilAt: UNTIL,
        reasonId: "justified",
        createdBy: T,
        createdAt: AT.toISOString(),
      },
    });
    expect(seen[0]!.text).toContain("institution.grant_late_submission_exception");
    expect(seen[0]!.values).toEqual([A, S, UNTIL, "justified"]);
  });

  it("an answer that is not this exception throws, so the write rolls back", async () => {
    const other = new Date("2026-12-28T23:00:00.000Z");
    for (const bad of [
      [],
      [row(), row()],
      [row({ studentId: "00000000-0000-4000-8000-0000000000e2" })],
      [row({ reasonId: "technical" })],
      [row({ untilAt: other })],
    ]) {
      await expect(port(bad).port.grantLateException(TOKEN, input)).rejects.toThrow();
    }
  });

  it("maps the refusals of the database", async () => {
    expect(await port(sqlError("ZD401")).port.grantLateException(TOKEN, input)).toEqual({
      status: "unauthorized",
    });
    expect(await port(sqlError("ZD403")).port.grantLateException(TOKEN, input)).toEqual({
      status: "not_found",
    });
    expect(await port(sqlError("ZD422")).port.grantLateException(TOKEN, input)).toEqual({
      status: "invalid_input",
    });
    await expect(port(sqlError("57014")).port.grantLateException(TOKEN, input)).rejects.toThrow();
  });
});

describe("listLateExceptions", () => {
  it("lists the exceptions; a reason may be null", async () => {
    const { port: p, seen } = port([row({ reasonId: null })]);
    expect(await p.listLateExceptions(TOKEN, A)).toMatchObject({
      status: "read",
      exceptions: [{ id: E, reasonId: null }],
    });
    expect(seen[0]!.values).toEqual([A]);
  });

  it("a malformed id is not_found and never sent", async () => {
    const { port: p, seen } = port([]);
    expect(await p.listLateExceptions(TOKEN, "nije-uuid")).toEqual({ status: "not_found" });
    expect(seen).toEqual([]);
  });

  it("a row it cannot vouch for throws; refusals are outcomes", async () => {
    await expect(
      port([row({ reasonId: "drugo" })]).port.listLateExceptions(TOKEN, A),
    ).rejects.toThrow();
    expect(await port(sqlError("ZD403")).port.listLateExceptions(TOKEN, A)).toEqual({
      status: "not_found",
    });
    expect(await port(sqlError("ZD401")).port.listLateExceptions(TOKEN, A)).toEqual({
      status: "unauthorized",
    });
  });
});

describe("listOwnLateExceptions", () => {
  it("marks every record as an exception and always carries the reason", async () => {
    const { port: p } = port([
      { id: E, untilAt: new Date(UNTIL), reasonId: "agreement", createdAt: AT },
    ]);
    expect(await p.listOwnLateExceptions(TOKEN, A)).toEqual({
      status: "read",
      exceptions: [
        {
          id: E,
          kind: "exception",
          untilAt: UNTIL,
          reasonId: "agreement",
          createdAt: AT.toISOString(),
        },
      ],
    });
  });

  it("a record without a reason is not vouched for; a malformed id is not_found", async () => {
    await expect(
      port([
        { id: E, untilAt: new Date(UNTIL), reasonId: null, createdAt: AT },
      ]).port.listOwnLateExceptions(TOKEN, A),
    ).rejects.toThrow();
    expect(await port([]).port.listOwnLateExceptions(TOKEN, "x")).toEqual({ status: "not_found" });
    expect(await port(sqlError("ZD403")).port.listOwnLateExceptions(TOKEN, A)).toEqual({
      status: "not_found",
    });
  });
});
