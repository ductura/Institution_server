// SRV-1903: the port of submission withdrawal over a fake withActor. Ids and
// keys are checked before the database, every outcome of the RPCs is closed,
// a row that is not what the RPC promises is thrown, and ZD401, ZD403 and
// ZD422 are outcomes. Every id, key and date below is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createSubmissionWithdrawals } from "./submission-withdrawal.ts";

const TOKEN = "izmisljeni-token-00000000000000000000000000";
const A = "00000000-0000-4000-8000-0000000000a1";
const S = "00000000-0000-4000-8000-0000000000e1";
const W = "6c1d4f3b-8e25-4a7c-8b9f-2d3e4f5a6b02";
const X = "5b0c3e2a-7d14-4f6b-9a8e-1c2d3e4f5a01";
const KEY = { keyId: "izmisljeni-kljuc", keyVersion: "1" };
const DIGEST = "a1".repeat(32);
const SIG = { algorithm: "Ed25519", keyId: "izmisljeni-kljuc" };
const AT = new Date("2026-12-20T21:40:00.654Z");

/** Answers each query in turn with the next of `answers`. */
function port(...answers: unknown[]) {
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values });
        const answer = answers.shift();
        if (answer instanceof Error) throw answer;
        return { rows: answer as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { port: createSubmissionWithdrawals(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });
const frozen = (over: Record<string, unknown> = {}) => ({
  outcome: "withdrawn",
  withdrawalId: W,
  receiptPayload: "{}",
  payloadDigestSha256: DIGEST,
  signature: null,
  ...over,
});
const event = (over: Record<string, unknown> = {}) => ({
  kind: "submission",
  eventId: X,
  attempt: 1,
  submissionId: X,
  revision: "7",
  at: AT,
  afterDeadline: false,
  receiptPayload: "{}",
  payloadDigestSha256: DIGEST,
  signature: SIG,
  ...over,
});

describe("withdraw", () => {
  it("checks the id and the key before the database", async () => {
    const { port: p, seen } = port();
    expect(await p.withdraw(TOKEN, "A1", KEY)).toEqual({ status: "not_found" });
    expect(await p.withdraw(TOKEN, A, { keyId: "", keyVersion: "1" })).toEqual({
      status: "invalid",
    });
    expect(await p.withdraw(TOKEN, A, { keyId: "k".repeat(257), keyVersion: "1" })).toEqual({
      status: "invalid",
    });
    expect(seen).toEqual([]);
  });

  it("passes the assignment and the key, and returns the frozen receipt", async () => {
    const { port: p, seen } = port([frozen()]);
    expect(await p.withdraw(TOKEN, A, KEY)).toEqual({
      status: "withdrawn",
      withdrawalId: W,
      receiptPayload: "{}",
      payloadDigestSha256: DIGEST,
      signature: null,
    });
    expect(seen[0]?.values).toEqual([A, "izmisljeni-kljuc", "1"]);
    expect(seen[0]?.text).toContain("app.withdraw_submission($1::uuid, $2, $3)");
  });

  it("returns an earlier withdrawal with its signature", async () => {
    const { port: p } = port([frozen({ outcome: "existing", signature: SIG })]);
    expect(await p.withdraw(TOKEN, A, KEY)).toMatchObject({ status: "existing", signature: SIG });
  });

  it.each([
    "unauthorized",
    "not_found",
    "none",
    "pending",
    "disabled",
    "after_deadline",
    "key_unavailable",
  ])("refusal %s is an outcome", async (outcome) => {
    const { port: p } = port([{ outcome }]);
    expect(await p.withdraw(TOKEN, A, KEY)).toEqual({ status: outcome });
  });

  it("throws for an unknown outcome, a malformed row or a signed new withdrawal", async () => {
    for (const rows of [
      [{ outcome: "deleted" }],
      [],
      [frozen(), frozen()],
      [frozen({ withdrawalId: "nije-id" })],
      [frozen({ payloadDigestSha256: "abc" })],
      [frozen({ signature: SIG })],
      [frozen({ signature: [SIG] })],
    ]) {
      await expect(port(rows).port.withdraw(TOKEN, A, KEY)).rejects.toThrow();
    }
  });
});

describe("attach", () => {
  it("checks the id and the digest before the database", async () => {
    const { port: p, seen } = port();
    expect(await p.attach(TOKEN, "x", DIGEST, SIG)).toEqual({ status: "invalid" });
    expect(await p.attach(TOKEN, W, "ABC", SIG)).toEqual({ status: "invalid" });
    expect(seen).toEqual([]);
  });

  it("sends the signature as JSON and returns what was bound", async () => {
    const bound = { receiptPayload: "{}", payloadDigestSha256: DIGEST, signature: SIG };
    const { port: p, seen } = port([{ outcome: "attached", ...bound }]);
    expect(await p.attach(TOKEN, W, DIGEST, SIG)).toEqual({ status: "attached", ...bound });
    expect(seen[0]?.values).toEqual([W, DIGEST, JSON.stringify(SIG)]);
  });

  it.each([
    "unauthorized",
    "invalid",
    "not_found",
    "digest_mismatch",
    "key_mismatch",
    "key_revoked",
    "key_not_valid",
  ])("refusal %s is an outcome", async (outcome) => {
    expect(await port([{ outcome }]).port.attach(TOKEN, W, DIGEST, SIG)).toEqual({
      status: outcome,
    });
  });

  it("a bound answer without a signature is thrown", async () => {
    await expect(
      port([
        { outcome: "existing", receiptPayload: "{}", payloadDigestSha256: DIGEST, signature: null },
      ]).port.attach(TOKEN, W, DIGEST, SIG),
    ).rejects.toThrow();
  });
});

describe("histories", () => {
  it("the student's: terms, then the events with numbers and instants", async () => {
    const { port: p, seen } = port(
      [{ outcome: "found", allowed: true, dueAt: new Date("2026-12-20T22:59:00.000Z") }],
      [event(), event({ kind: "withdrawal", eventId: W, afterDeadline: null, signature: null })],
    );
    expect(await p.studentHistory(TOKEN, A)).toEqual({
      status: "read",
      withdrawalAllowed: true,
      dueAt: "2026-12-20T22:59:00.000Z",
      events: [
        {
          kind: "submission",
          id: X,
          attempt: 1,
          submissionId: X,
          revision: 7,
          at: AT.toISOString(),
          afterDeadline: false,
          receiptPayload: "{}",
          payloadDigestSha256: DIGEST,
          signature: SIG,
        },
        {
          kind: "withdrawal",
          id: W,
          attempt: 1,
          submissionId: X,
          revision: 7,
          at: AT.toISOString(),
          afterDeadline: null,
          receiptPayload: "{}",
          payloadDigestSha256: DIGEST,
          signature: null,
        },
      ],
    });
    expect(seen.map((s) => s.values)).toEqual([[A], [A]]);
  });

  it("not a student of the assignment is not_found, without reading the events", async () => {
    const { port: p, seen } = port([{ outcome: "not_found", allowed: null, dueAt: null }]);
    expect(await p.studentHistory(TOKEN, A)).toEqual({ status: "not_found" });
    expect(seen).toHaveLength(1);
  });

  it("the teacher's: ZD403 and ZD401 are outcomes, a malformed id never reaches the database", async () => {
    expect(await port(sqlError("ZD403")).port.teacherHistory(TOKEN, A, S)).toEqual({
      status: "not_found",
    });
    expect(await port(sqlError("ZD401")).port.teacherHistory(TOKEN, A, S)).toEqual({
      status: "unauthorized",
    });
    const { port: p, seen } = port();
    expect(await p.teacherHistory(TOKEN, A, "S")).toEqual({ status: "not_found" });
    expect(seen).toEqual([]);
    await expect(port(sqlError("XX000")).port.teacherHistory(TOKEN, A, S)).rejects.toThrow();
  });

  it("a row the history does not promise is thrown", async () => {
    for (const row of [
      event({ kind: "deletion" }),
      event({ revision: "0" }),
      event({ attempt: 0 }),
      event({ afterDeadline: null }),
      event({ kind: "withdrawal", afterDeadline: true }),
      event({ receiptPayload: null }),
      event({ at: "2026-12-20" }),
    ]) {
      await expect(port([row]).port.teacherHistory(TOKEN, A, S)).rejects.toThrow();
    }
  });
});

describe("the switch", () => {
  it("reads it, null when never set", async () => {
    expect(await port([{ allowed: true, changedAt: null }]).port.setting(TOKEN, A)).toEqual({
      status: "read",
      allowed: true,
      changedAt: null,
    });
  });

  it("sets it and confirms the answer inside the transaction", async () => {
    const { port: p, seen } = port([{ allowed: false, changedAt: AT }]);
    expect(await p.setSetting(TOKEN, A, false)).toEqual({
      status: "read",
      allowed: false,
      changedAt: AT.toISOString(),
    });
    expect(seen[0]?.values).toEqual([A, false]);
    await expect(
      port([{ allowed: true, changedAt: AT }]).port.setSetting(TOKEN, A, false),
    ).rejects.toThrow();
  });

  it("maps ZD403, ZD401 and ZD422", async () => {
    expect(await port(sqlError("ZD403")).port.setSetting(TOKEN, A, true)).toEqual({
      status: "not_found",
    });
    expect(await port(sqlError("ZD401")).port.setting(TOKEN, A)).toEqual({
      status: "unauthorized",
    });
    expect(await port(sqlError("ZD422")).port.setSetting(TOKEN, A, true)).toEqual({
      status: "invalid_input",
    });
  });
});
