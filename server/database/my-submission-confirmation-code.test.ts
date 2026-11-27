// SRV-KOD-POTVRDE (Ductus#2059, S-08): the confirmation code of the own submission.
// Who asks comes only from the token inside withActor; another's assignment is
// not_found; a code outside the alphabet without I, L, O and U is ROW_MALFORMED.
// Every token and id below is invented.
import { describe, expect, it } from "vitest";

import { createMySubmissionConfirmationCodeReader } from "./my-submission-confirmation-code.ts";
import {
  MY_SUBMISSION_STATE_DATABASE_ERROR,
  MY_SUBMISSION_STATE_NOT_FOUND,
  MY_SUBMISSION_STATE_ROW_MALFORMED,
  MY_SUBMISSION_STATE_UNAUTHENTICATED,
} from "./my-submission-state.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-koda-potvrde-".padEnd(43, "0");
const A = "00000000-0000-4000-8000-0000000000a1";
const S = "00000000-0000-4000-8000-0000000000b1";
const CODE = "DK7M-4Q9P-X2HT-R8VN";

function reader(answer: unknown) {
  let calls = 0;
  const withActor = (async (_token, fn) => {
    calls += 1;
    const tx: ActorTransaction = {
      async query() {
        if (answer instanceof Error) throw answer;
        return { rows: answer as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { port: createMySubmissionConfirmationCodeReader(withActor), calls: () => calls };
}
const found = (code: unknown) => [{ outcome: "found", code }];

describe("createMySubmissionConfirmationCodeReader", () => {
  it("refuses a missing or malformed token and a malformed id without a query", async () => {
    const { port, calls } = reader(found(CODE));
    expect(await port.read(undefined, A)).toEqual({
      ok: false,
      error: MY_SUBMISSION_STATE_UNAUTHENTICATED,
    });
    expect(await port.read("kratak", A)).toEqual({
      ok: false,
      error: MY_SUBMISSION_STATE_UNAUTHENTICATED,
    });
    expect(await port.read(TOKEN, "nije-uuid")).toEqual({
      ok: false,
      error: MY_SUBMISSION_STATE_NOT_FOUND,
    });
    expect(calls()).toBe(0);
  });

  it("maps not_found to not_found and a session error to unauthenticated", async () => {
    expect(await reader([{ outcome: "not_found", code: null }]).port.read(TOKEN, A)).toEqual({
      ok: false,
      error: MY_SUBMISSION_STATE_NOT_FOUND,
    });
    const denied = Object.assign(new Error("x"), { code: "ZD401" });
    expect(await reader(denied).port.read(TOKEN, A)).toEqual({
      ok: false,
      error: MY_SUBMISSION_STATE_UNAUTHENTICATED,
    });
    expect(await reader(new Error("x")).port.read(TOKEN, A)).toEqual({
      ok: false,
      error: MY_SUBMISSION_STATE_DATABASE_ERROR,
    });
  });

  it("gives the code, or null while no receipt is bound", async () => {
    expect(await reader(found(CODE)).port.read(TOKEN, A)).toEqual({ ok: true, value: CODE });
    expect(await reader(found(null)).port.read(TOKEN, A)).toEqual({ ok: true, value: null });
  });

  it.each([
    ["no row", []],
    ["two rows", [...found(CODE), ...found(CODE)]],
    ["a letter I", found("IK7M-4Q9P-X2HT-R8VN")],
    ["a letter L", found("DK7M-4Q9P-X2HT-R8VL")],
    ["a letter O", found("DK7M-4Q9P-X2HT-R8VO")],
    ["a letter U", found("DK7M-4Q9P-X2HT-R8VU")],
    ["lower case", found("dk7m-4q9p-x2ht-r8vn")],
    ["no groups", found("DK7M4Q9PX2HTR8VN")],
    ["a code on not_found", [{ outcome: "not_found", code: CODE }]],
    ["an unknown outcome", [{ outcome: "other", code: null }]],
  ])("is ROW_MALFORMED for %s", async (_name, rows) => {
    expect(await reader(rows).port.read(TOKEN, A)).toEqual({
      ok: false,
      error: MY_SUBMISSION_STATE_ROW_MALFORMED,
    });
  });

  describe("teacherRead", () => {
    it("refuses a missing token and a malformed id of either kind without a query", async () => {
      const { port, calls } = reader(found(CODE));
      expect(await port.teacherRead(undefined, A, S)).toEqual({
        ok: false,
        error: MY_SUBMISSION_STATE_UNAUTHENTICATED,
      });
      expect(await port.teacherRead(TOKEN, "nije-uuid", S)).toEqual({
        ok: false,
        error: MY_SUBMISSION_STATE_NOT_FOUND,
      });
      expect(await port.teacherRead(TOKEN, A, "nije-uuid")).toEqual({
        ok: false,
        error: MY_SUBMISSION_STATE_NOT_FOUND,
      });
      expect(calls()).toBe(0);
    });

    it("maps every refusal of the reader's check (ZD403) to not_found", async () => {
      const refused = Object.assign(new Error("x"), { code: "ZD403" });
      expect(await reader(refused).port.teacherRead(TOKEN, A, S)).toEqual({
        ok: false,
        error: MY_SUBMISSION_STATE_NOT_FOUND,
      });
      const denied = Object.assign(new Error("x"), { code: "ZD401" });
      expect(await reader(denied).port.teacherRead(TOKEN, A, S)).toEqual({
        ok: false,
        error: MY_SUBMISSION_STATE_UNAUTHENTICATED,
      });
      expect(await reader(new Error("x")).port.teacherRead(TOKEN, A, S)).toEqual({
        ok: false,
        error: MY_SUBMISSION_STATE_DATABASE_ERROR,
      });
    });

    it("gives the code or null, and a code outside the alphabet is ROW_MALFORMED", async () => {
      expect(await reader(found(CODE)).port.teacherRead(TOKEN, A, S)).toEqual({
        ok: true,
        value: CODE,
      });
      expect(await reader(found(null)).port.teacherRead(TOKEN, A, S)).toEqual({
        ok: true,
        value: null,
      });
      expect(await reader(found("IK7M-4Q9P-X2HT-R8VN")).port.teacherRead(TOKEN, A, S)).toEqual({
        ok: false,
        error: MY_SUBMISSION_STATE_ROW_MALFORMED,
      });
    });
  });

  it("keeps ZD403 of the student's own read a database error (it answers not_found itself)", async () => {
    const refused = Object.assign(new Error("x"), { code: "ZD403" });
    expect(await reader(refused).port.read(TOKEN, A)).toEqual({
      ok: false,
      error: MY_SUBMISSION_STATE_DATABASE_ERROR,
    });
  });
});
