// SRV-1230: the port of the match with the assistant over a fake withActor. The
// comparison is the pure one; refusals are outcomes, a row of an unexpected shape
// is unavailable, only matches are recorded, and nothing but ids and a number is
// passed on. All values are invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createAssistantMatch } from "./index.ts";

const TOKEN = "izmisljeni-token-studenta-0000000000000001";
const CONVERSATION = "00000000-0000-4000-8000-0000000000c1";
const MESSAGE = "00000000-0000-4000-8000-0000000000c2";
const ANSWER =
  "kišobrani na tramvajskoj stanici čuvaju putnike od kiše a vjetar ih ponekad prevrne";

function port(answer: (text: string) => unknown) {
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values });
        const rows = answer(text);
        if (rows instanceof Error) throw rows;
        return { rows: rows as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { port: createAssistantMatch(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });
const answers = (text = ANSWER) => [
  { conversationId: CONVERSATION, messageId: MESSAGE, content: text },
];

describe("check", () => {
  it("records each match with its run and returns ids and a number only", async () => {
    const { port: match, seen } = port((sql) =>
      sql.includes("_responses") ? answers() : [{ recorded: true }],
    );
    const result = await match.check(
      TOKEN,
      "izmisljeni-rad-0001",
      "blok-1",
      `Moje: ${ANSWER} i kraj.`,
    );
    expect(result).toEqual({
      status: "ok",
      matches: [{ messageId: MESSAGE, conversationId: CONVERSATION, runWords: 13 }],
    });
    expect(seen).toHaveLength(2);
    expect(seen[1]!.values).toEqual(["izmisljeni-rad-0001", "blok-1", MESSAGE, 13]);
    expect(JSON.stringify(seen[1]!.values)).not.toContain("tramvajskoj");
  });

  it("records nothing when no answer matches or none is handed over (switch off)", async () => {
    const none = port(() => []);
    expect(await none.port.check(TOKEN, "izmisljeni-rad-0001", "blok-1", ANSWER)).toEqual({
      status: "ok",
      matches: [],
    });
    expect(none.seen).toHaveLength(1);
    const other = port(() => answers("sasvim drugi tekst bez ičega zajedničkog s time"));
    expect(await other.port.check(TOKEN, "izmisljeni-rad-0001", "blok-1", ANSWER)).toEqual({
      status: "ok",
      matches: [],
    });
    expect(other.seen).toHaveLength(1);
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid"],
    ["XX000", "unavailable"],
  ])("maps %s to %s", async (code, status) => {
    const { port: match } = port(() => sqlError(code));
    expect(await match.check(TOKEN, "izmisljeni-rad-0001", "blok-1", ANSWER)).toEqual({ status });
  });

  it("an answer row of an unexpected shape is unavailable", async () => {
    const { port: match } = port(() => [
      { conversationId: "nije-uuid", messageId: MESSAGE, content: "x" },
    ]);
    expect(await match.check(TOKEN, "izmisljeni-rad-0001", "blok-1", ANSWER)).toEqual({
      status: "unavailable",
    });
  });
});

describe("list", () => {
  const row = {
    segmentRef: "blok-1",
    conversationId: CONVERSATION,
    messageId: MESSAGE,
    runWords: 9,
    recordedAt: new Date("2026-11-22T10:00:00.000Z"),
    attachedAt: "2026-11-22T10:00:00.000Z",
  };

  const findingsOnly = (rows: unknown) => (sql: string) =>
    sql.includes("_explanations") ? [] : rows;

  it("returns the findings with instants as ISO text", async () => {
    const { port: match, seen } = port(findingsOnly([row]));
    expect(await match.list(TOKEN, "izmisljeni-rad-0001")).toEqual({
      status: "ok",
      findings: [
        {
          segmentRef: "blok-1",
          conversationId: CONVERSATION,
          messageId: MESSAGE,
          runWords: 9,
          recordedAt: "2026-11-22T10:00:00.000Z",
          attachedAt: "2026-11-22T10:00:00.000Z",
          explanation: null,
        },
      ],
    });
    expect(seen[0]!.values).toEqual(["izmisljeni-rad-0001"]);
    expect(seen[1]!.values).toEqual(["izmisljeni-rad-0001"]);
  });

  it("refuses a run under 8 words and maps ZD403 to not_found", async () => {
    expect(await port(findingsOnly([{ ...row, runWords: 7 }])).port.list(TOKEN, "x")).toEqual({
      status: "unavailable",
    });
    expect(await port(() => sqlError("ZD403")).port.list(TOKEN, "x")).toEqual({
      status: "not_found",
    });
  });

  it("joins each explanation to its finding by segment and answer", async () => {
    const other = "00000000-0000-4000-8000-0000000000c3";
    const { port: match } = port((sql) =>
      sql.includes("_explanations")
        ? [
            {
              segmentRef: "blok-1",
              messageId: MESSAGE,
              text: "Izmišljeno objašnjenje.",
              writtenAt: new Date("2026-11-23T08:00:00.000Z"),
            },
          ]
        : [row, { ...row, messageId: other }, { ...row, segmentRef: "blok-2" }],
    );
    const result = await match.list(TOKEN, "izmisljeni-rad-0001");
    expect(result.status).toBe("ok");
    const explanations = result.status === "ok" ? result.findings.map((f) => f.explanation) : [];
    expect(explanations).toEqual([
      { text: "Izmišljeno objašnjenje.", writtenAt: "2026-11-23T08:00:00.000Z" },
      null,
      null,
    ]);
  });

  it("an explanation row of an unexpected shape is unavailable", async () => {
    const { port: match } = port((sql) =>
      sql.includes("_explanations")
        ? [{ segmentRef: "blok-1", messageId: "nije-uuid", text: "x", writtenAt: new Date() }]
        : [row],
    );
    expect(await match.list(TOKEN, "x")).toEqual({ status: "unavailable" });
  });
});

describe("explain", () => {
  it("passes the explanation to the RPC and returns it with its time", async () => {
    const { port: match, seen } = port(() => [{ writtenAt: new Date("2026-11-23T08:00:00.000Z") }]);
    expect(
      await match.explain(
        TOKEN,
        "izmisljeni-rad-0001",
        "blok-1",
        MESSAGE,
        "Izmišljeno objašnjenje.",
      ),
    ).toEqual({
      status: "ok",
      explanation: { text: "Izmišljeno objašnjenje.", writtenAt: "2026-11-23T08:00:00.000Z" },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toContain("app.assistant_match_explain(");
    expect(seen[0]!.values).toEqual([
      "izmisljeni-rad-0001",
      "blok-1",
      MESSAGE,
      "Izmišljeno objašnjenje.",
    ]);
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD409", "conflict"],
    ["ZD422", "invalid"],
    ["XX000", "unavailable"],
  ])("maps %s to %s", async (code, status) => {
    const { port: match } = port(() => sqlError(code));
    expect(await match.explain(TOKEN, "x", "blok-1", MESSAGE, "Tekst.")).toEqual({ status });
  });

  it("no time back is unavailable", async () => {
    expect(
      await port(() => [{ writtenAt: null }]).port.explain(TOKEN, "x", "b", MESSAGE, "T"),
    ).toEqual({
      status: "unavailable",
    });
    expect(await port(() => []).port.explain(TOKEN, "x", "b", MESSAGE, "T")).toEqual({
      status: "unavailable",
    });
  });
});
