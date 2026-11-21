// The port of the assistant requests (SRV-1203) over a scripted transaction:
// the SQL and parameters each call sends, the mapping of rows, and the closed
// statuses for database errors and rows of an unexpected shape. The database
// itself is covered by db/main/tests/171-assistant-rpcs.sql and
// tests/db/assistant-*.integration.test.ts. Every text and id is invented.
import { describe, expect, it } from "vitest";

import type { WithActor } from "../index.ts";

import { createAssistantRequests, sweepAndSettle } from "./assistant-requests.ts";

const REQ = "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e01";
const CONV = "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e02";
const AT = new Date("2026-11-22T09:00:00.000Z");

function scripted(rows: Record<string, unknown>[], error?: unknown) {
  const calls: { text: string; values: readonly unknown[] }[] = [];
  const withActor = (async (_token, fn) =>
    fn({
      query: async (text: string, values: readonly unknown[] = []) => {
        calls.push({ text, values });
        if (error !== undefined) throw error;
        return { rows, rowCount: rows.length };
      },
    } as never)) as WithActor;
  return { port: createAssistantRequests(withActor), calls };
}
const dbError = (code: string) => Object.assign(new Error("izmišljena greška"), { code });
const INPUT = {
  idempotencyKey: "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e03",
  assignmentId: "7b6c5d4e-3f2a-4b1c-8d9e-0a1b2c3d4e04",
  conversationId: null,
  purposeCatalogVersion: 1,
  purposeKey: "proofreading",
  paragraph: "Izmišljeni odlomak.",
  providerId: "provider-test-a",
  modelId: "model-test-1",
  configVersion: "test-1",
};
const BEGUN = {
  requestId: REQ,
  conversationId: CONV,
  state: "reserved",
  reason: null,
  replayed: false,
  responseId: null,
  response: null,
};

describe("createAssistantRequests", () => {
  it("begins a request with the nine parameters in the order of the RPC", async () => {
    const run = scripted([BEGUN]);
    expect(await run.port.begin("t", INPUT)).toEqual({
      status: "ok",
      requestId: REQ,
      conversationId: CONV,
      state: "reserved",
      reason: null,
      replayed: false,
      response: null,
    });
    expect(run.calls[0]!.text).toContain(
      "assistant.begin_request($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    );
    expect(run.calls[0]!.values).toEqual([
      INPUT.idempotencyKey,
      INPUT.assignmentId,
      null,
      1,
      "proofreading",
      "Izmišljeni odlomak.",
      "provider-test-a",
      "model-test-1",
      "test-1",
    ]);
  });

  it("returns the stored response of a replayed completed request", async () => {
    const run = scripted([
      {
        ...BEGUN,
        state: "completed",
        replayed: true,
        responseId: CONV,
        response: "Izmišljeni odgovor.",
      },
    ]);
    expect(await run.port.begin("t", INPUT)).toMatchObject({
      replayed: true,
      response: { id: CONV, text: "Izmišljeni odgovor." },
    });
  });

  it("maps a refusal row with its reason", async () => {
    const run = scripted([
      { ...BEGUN, conversationId: null, state: "rejected", reason: "budget_exceeded" },
    ]);
    expect(await run.port.begin("t", INPUT)).toMatchObject({
      state: "rejected",
      reason: "budget_exceeded",
    });
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "forbidden"],
    ["ZD409", "idempotency_conflict"],
    ["ZD422", "invalid"],
    ["08006", "unavailable"],
  ])("maps %s from begin to %s", async (code, status) => {
    expect(await scripted([], dbError(code)).port.begin("t", INPUT)).toEqual({ status });
  });

  it("maps ZD409 elsewhere to conflict", async () => {
    expect(await scripted([], dbError("ZD409")).port.markSent("t", REQ)).toEqual({
      status: "conflict",
    });
  });

  it.each([
    [{ ...BEGUN, state: "pending" }],
    [{ ...BEGUN, reason: "quota" }],
    [{ ...BEGUN, replayed: "no" }],
    [{ ...BEGUN, requestId: 5 }],
  ])("answers unavailable for a malformed begin row %#", async (row) => {
    expect(await scripted([row]).port.begin("t", INPUT)).toEqual({ status: "unavailable" });
  });

  it("answers unavailable for no row or two rows", async () => {
    expect(await scripted([]).port.begin("t", INPUT)).toEqual({ status: "unavailable" });
    expect(await scripted([BEGUN, BEGUN]).port.begin("t", INPUT)).toEqual({
      status: "unavailable",
    });
  });

  it("marks a request sent, or rejected with a reason", async () => {
    expect(await scripted([{ state: "sent", reason: null }]).port.markSent("t", REQ)).toEqual({
      status: "ok",
      state: "sent",
      reason: null,
    });
    expect(
      await scripted([{ state: "rejected", reason: "purpose_not_allowed" }]).port.markSent(
        "t",
        REQ,
      ),
    ).toEqual({ status: "ok", state: "rejected", reason: "purpose_not_allowed" });
    expect(await scripted([{ state: "completed", reason: null }]).port.markSent("t", REQ)).toEqual({
      status: "unavailable",
    });
  });

  it("sends the actual cost as a decimal string, never a float", async () => {
    const run = scripted([{ state: "completed", accepted: true, responseId: CONV }]);
    expect(
      await run.port.complete("t", REQ, "Izmišljeni odgovor.", 9_007_199_254_740_993n),
    ).toEqual({
      status: "ok",
      state: "completed",
      accepted: true,
      responseId: CONV,
    });
    expect(run.calls[0]!.values).toEqual([REQ, "Izmišljeni odgovor.", "9007199254740993"]);
  });

  it("reports a late response as not accepted (R7)", async () => {
    const run = scripted([{ state: "outcome_unknown", accepted: false, responseId: null }]);
    expect(await run.port.complete("t", REQ, "Kasno.", 3n)).toMatchObject({ accepted: false });
  });

  it("fails a request with the closed reason and an optional cost", async () => {
    const run = scripted([{ state: "provider_failed", accepted: true }]);
    expect(await run.port.fail("t", REQ, null)).toEqual({
      status: "ok",
      state: "provider_failed",
      accepted: true,
    });
    expect(run.calls[0]!.text).toContain("'provider_failed'");
    expect(run.calls[0]!.values).toEqual([REQ, null]);
  });

  it("marks the outcome unknown", async () => {
    expect(
      await scripted([{ state: "outcome_unknown" }]).port.markOutcomeUnknown("t", REQ),
    ).toEqual({
      status: "ok",
      state: "outcome_unknown",
    });
  });

  it("reads a conversation in the order the database gives", async () => {
    const row = {
      seq: 1,
      id: REQ,
      requestId: REQ,
      role: "student_paragraph",
      content: "Izmišljeni odlomak.",
      contentSha256: "a".repeat(64),
      createdAt: AT,
      requestState: "completed",
    };
    const answer = await scripted([
      row,
      { ...row, seq: 2, role: "provider_response" },
    ]).port.readConversation("t", CONV);
    expect(answer).toMatchObject({ status: "ok" });
    expect(
      "messages" in answer && answer.messages.map((m) => [m.seq, m.role, m.createdAt]),
    ).toEqual([
      [1, "student_paragraph", "2026-11-22T09:00:00.000Z"],
      [2, "provider_response", "2026-11-22T09:00:00.000Z"],
    ]);
    expect(await scripted([{ ...row, role: "system" }]).port.readConversation("t", CONV)).toEqual({
      status: "unavailable",
    });
  });

  it("publishes a configuration and passes limits as decimal strings or null", async () => {
    const run = scripted([{ outcome: "limit_above_cap", version: 2 }]);
    expect(
      await run.port.publishCostConfig("t", {
        expectedVersion: 2,
        studentDayMicro: 30n,
        studentAssignmentDayMicro: null,
        reserveMicro: 7n,
      }),
    ).toEqual({ status: "limit_above_cap", version: 2 });
    expect(run.calls[0]!.values).toEqual([2, "30", null, "7"]);
  });
});

describe("sweepAndSettle", () => {
  it("returns the state after the sweep", async () => {
    const calls: unknown[][] = [];
    const query = async (text: string, values: readonly unknown[]) => {
      calls.push([text, ...values]);
      return { rows: [{ state: "settled" }] };
    };
    expect(await sweepAndSettle(query, REQ)).toEqual({ status: "ok", state: "settled" });
    expect(calls).toEqual([["SELECT assistant.sweep_and_settle($1) AS state", REQ]]);
  });

  it("maps forbidden and a malformed row", async () => {
    expect(
      await sweepAndSettle(async () => {
        throw dbError("ZD403");
      }, REQ),
    ).toEqual({ status: "forbidden" });
    expect(await sweepAndSettle(async () => ({ rows: [{ state: "x" }] }), REQ)).toEqual({
      status: "unavailable",
    });
  });
});
