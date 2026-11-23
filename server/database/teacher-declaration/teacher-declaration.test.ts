import { expect, it } from "vitest";

import type { WithActor } from "../index.ts";
import { createTeacherDeclarationReader } from "./index.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const STUDENT = "00000000-0000-4000-8000-0000000000b1";
const PAYLOAD = '{"declarationSchema":"ductura-declaration-v1","revision":3}';
const HASH = "c".repeat(64);

const NO_QUESTION = [{ question: null, answer: null }];

function setup(answer: object[] | Error, question: object[] = NO_QUESTION) {
  const calls: (readonly unknown[] | undefined)[] = [];
  const withActor: WithActor = async (_token, run) =>
    run({
      async query<Row>(sql: string, params?: readonly unknown[]) {
        if (answer instanceof Error) throw answer;
        // SRV-IZJAVA-PITANJE: the second read of the same transaction.
        if (sql.includes("teacher_declaration_answer")) {
          return { rows: question as Row[], rowCount: question.length };
        }
        calls.push(params);
        return { rows: answer as Row[], rowCount: answer.length };
      },
    });
  return { read: createTeacherDeclarationReader(withActor), calls };
}

/** A database row, with the column names the RPC returns. */
const row = (state: string, payload: string | null, hash: string | null) =>
  Object.fromEntries([
    ["state", state],
    ["payload_jcs", payload],
    ["declaration_sha256", hash],
  ]);

const coded = (code: string) => Object.assign(new Error("refused"), { code });

it("returns the bound payload parsed from its canonical text", async () => {
  const { read, calls } = setup([row("bound", PAYLOAD, HASH)]);
  expect(await read("session", ASSIGNMENT.toUpperCase(), STUDENT)).toEqual({
    status: "ok",
    body: {
      state: "bound",
      payload: JSON.parse(PAYLOAD),
      declarationSha256: HASH,
      question: null,
      questionAnswer: null,
    },
  });
  expect(calls).toEqual([[ASSIGNMENT, STUDENT]]);
});

const QUESTION = {
  questionId: "00000000-0000-4000-8000-0000000000e1",
  text: "Izmišljeno pitanje?",
};
const ANSWER = { ...QUESTION, questionText: QUESTION.text, text: "Izmišljeni odgovor." };

it("SRV-IZJAVA-PITANJE: adds the question and the bound answer", async () => {
  const { read } = setup([row("bound", PAYLOAD, HASH)], [{ question: QUESTION, answer: ANSWER }]);
  const result = await read("session", ASSIGNMENT, STUDENT);
  expect(result).toMatchObject({ body: { question: QUESTION, questionAnswer: ANSWER } });
});

it("SRV-IZJAVA-PITANJE: shows no answer without a bound declaration", async () => {
  const { read } = setup([row("none", null, null)], [{ question: QUESTION, answer: ANSWER }]);
  expect(await read("session", ASSIGNMENT, STUDENT)).toMatchObject({
    body: { state: "none", question: QUESTION, questionAnswer: null },
  });
});

it("SRV-IZJAVA-PITANJE: is unavailable without the answer row", async () => {
  const { read } = setup([row("bound", PAYLOAD, HASH)], []);
  expect(await read("session", ASSIGNMENT, STUDENT)).toEqual({ status: "unavailable" });
});

it("answers none without a live submission", async () => {
  const { read } = setup([row("none", null, null)]);
  expect(await read("session", ASSIGNMENT, STUDENT)).toEqual({
    status: "ok",
    body: {
      state: "none",
      payload: null,
      declarationSha256: null,
      question: null,
      questionAnswer: null,
    },
  });
});

it("does not ask the database for an id that is not a uuid", async () => {
  const { read, calls } = setup([]);
  expect(await read("session", "nije-uuid", STUDENT)).toEqual({ status: "not_found" });
  expect(calls).toEqual([]);
});

it.each([
  ["ZD401", "unauthenticated"],
  ["ZD403", "not_found"],
  ["57014", "unavailable"],
])("maps %s to %s", async (code, status) => {
  const { read } = setup(coded(code));
  expect(await read("session", ASSIGNMENT, STUDENT)).toEqual({ status });
});

it.each([
  ["no row", []],
  ["an unknown state", [row("draft", PAYLOAD, HASH)]],
  ["a short hash", [row("bound", PAYLOAD, "c")]],
  ["text that is not JSON", [row("bound", "{", HASH)]],
])("is unavailable for %s", async (_name, rows) => {
  const { read } = setup(rows);
  expect(await read("session", ASSIGNMENT, STUDENT)).toEqual({ status: "unavailable" });
});
