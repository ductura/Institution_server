// SRV-IZJAVA-PITANJE: the teacher's declaration question adapter. Refusals are
// outcomes; any other answer is an error. All values are invented.
import { describe, expect, it } from "vitest";

import type { WithActor } from "../index.ts";

import { createDeclarationQuestionPort } from "./index.ts";

const ID = "00000000-0000-4000-8000-0000000000a1";
const AT = new Date("2026-11-21T10:00:00.000Z");

function over(answer: unknown[] | Error): { withActor: WithActor; seen: unknown[][] } {
  const seen: unknown[][] = [];
  const withActor = (async (token: string, run: (tx: unknown) => unknown) =>
    run({
      async query(text: string, values: unknown[]) {
        seen.push([token, text, values]);
        if (answer instanceof Error) throw answer;
        return { rows: answer, rowCount: answer.length };
      },
    })) as unknown as WithActor;
  return { withActor, seen };
}
const coded = (code: string) => Object.assign(new Error("refused"), { code });

describe("createDeclarationQuestionPort", () => {
  it("reads the question with the time of its last change", async () => {
    const { withActor, seen } = over([{ question: "Izmišljeno pitanje?", changedAt: AT }]);
    expect(await createDeclarationQuestionPort(withActor).read("t", ID)).toEqual({
      status: "read",
      question: "Izmišljeno pitanje?",
      changedAt: "2026-11-21T10:00:00.000Z",
    });
    expect(seen[0]?.[2]).toEqual([ID]);
  });

  it("reads no question, never changed", async () => {
    const { withActor } = over([{ question: null, changedAt: null }]);
    expect(await createDeclarationQuestionPort(withActor).read("t", ID)).toEqual({
      status: "read",
      question: null,
      changedAt: null,
    });
  });

  it("sets and confirms the question in the same transaction", async () => {
    const { withActor, seen } = over([{ question: "Novo?", changedAt: AT }]);
    expect(await createDeclarationQuestionPort(withActor).set("t", ID, "Novo?")).toMatchObject({
      status: "read",
      question: "Novo?",
    });
    expect(seen[0]?.[2]).toEqual([ID, "Novo?"]);
  });

  it("removes the question with null", async () => {
    const { withActor, seen } = over([{ question: null, changedAt: AT }]);
    expect(await createDeclarationQuestionPort(withActor).set("t", ID, null)).toMatchObject({
      status: "read",
      question: null,
    });
    expect(seen[0]?.[2]).toEqual([ID, null]);
  });

  it("an unconfirmed write is an error, so the transaction rolls back", async () => {
    const { withActor } = over([{ question: "Drugo?", changedAt: AT }]);
    await expect(createDeclarationQuestionPort(withActor).set("t", ID, "Novo?")).rejects.toThrow(
      "Unconfirmed declaration question",
    );
  });

  it("does not ask the database for an id that is not a lower-case uuid", async () => {
    const { withActor, seen } = over([]);
    const port = createDeclarationQuestionPort(withActor);
    expect(await port.read("t", "nije-uuid")).toEqual({ status: "not_found" });
    expect(await port.set("t", ID.toUpperCase(), null)).toEqual({ status: "not_found" });
    expect(seen).toEqual([]);
  });

  it.each([
    ["ZD401", "unauthorized"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid_input"],
  ])("%s is %s", async (code, status) => {
    const port = createDeclarationQuestionPort(over(coded(code)).withActor);
    expect(await port.read("t", ID)).toEqual({ status });
    expect(await port.set("t", ID, "Pitanje?")).toEqual({ status });
  });

  it.each([
    ["no row", []],
    [
      "two rows",
      [
        { question: null, changedAt: null },
        { question: null, changedAt: null },
      ],
    ],
    ["a number", [{ question: 1, changedAt: null }]],
    ["a time that is not a date", [{ question: null, changedAt: "jučer" }]],
  ])("%s is an error", async (_name, rows) => {
    await expect(createDeclarationQuestionPort(over(rows).withActor).read("t", ID)).rejects.toThrow(
      "Invalid declaration question response",
    );
  });

  it("another database error is thrown", async () => {
    await expect(
      createDeclarationQuestionPort(over(coded("57014")).withActor).read("t", ID),
    ).rejects.toThrow("refused");
  });
});
