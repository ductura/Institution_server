import { expect, it } from "vitest";

import type { WithActor } from "../index.ts";
import { createTeacherDeclarationReader } from "./index.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const STUDENT = "00000000-0000-4000-8000-0000000000b1";
const PAYLOAD = '{"declarationSchema":"ductura-declaration-v1","revision":3}';
const HASH = "c".repeat(64);

function setup(answer: object[] | Error) {
  const calls: (readonly unknown[] | undefined)[] = [];
  const withActor: WithActor = async (_token, run) =>
    run({
      async query<Row>(_sql: string, params?: readonly unknown[]) {
        calls.push(params);
        if (answer instanceof Error) throw answer;
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
    body: { state: "bound", payload: JSON.parse(PAYLOAD), declarationSha256: HASH },
  });
  expect(calls).toEqual([[ASSIGNMENT, STUDENT]]);
});

it("answers none without a live submission", async () => {
  const { read } = setup([row("none", null, null)]);
  expect(await read("session", ASSIGNMENT, STUDENT)).toEqual({
    status: "ok",
    body: { state: "none", payload: null, declarationSha256: null },
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
