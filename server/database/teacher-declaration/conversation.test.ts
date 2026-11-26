import { expect, it } from "vitest";

import type { WithActor } from "../index.ts";
import { createTeacherDeclarationConversationReader } from "./conversation.ts";

const A = "00000000-0000-4000-8000-0000000000a1";
const S = "00000000-0000-4000-8000-0000000000b1";
const C = "00000000-0000-4000-8000-0000000000c1";
const SHA = "b".repeat(64);

function setup(result: object[] | Error) {
  const calls: (readonly unknown[] | undefined)[] = [];
  const withActor: WithActor = async (_token, run) =>
    run({
      async query<Row>(_sql: string, params?: readonly unknown[]) {
        if (result instanceof Error) throw result;
        calls.push(params);
        return { rows: result as Row[], rowCount: result.length };
      },
    });
  return { read: createTeacherDeclarationConversationReader(withActor), calls };
}

const msg = (seq: number, role = "student_paragraph", through = 2) =>
  Object.fromEntries([
    ["seq", seq],
    ["role", role],
    ["content", `Izmišljena poruka ${seq}`],
    ["content_sha256", "c".repeat(64)],
    ["created_at", new Date("2026-11-20T09:00:00.000Z")],
    ["through_seq", through],
    ["messages_sha256", SHA],
  ]);
const coded = (code: string) => Object.assign(new Error("refused"), { code });

it("returns the attached messages up to throughSeq", async () => {
  const { read, calls } = setup([msg(1), msg(2, "provider_response")]);
  const result = await read("session", A.toUpperCase(), S, C);
  expect(result).toMatchObject({
    status: "ok",
    body: { conversationId: C, throughSeq: 2, messagesSha256: SHA },
  });
  expect(result.status === "ok" && result.body.messages.map((m) => m.seq)).toEqual([1, 2]);
  expect(calls).toEqual([[A, S, C]]);
});

it("does not ask the database for an id that is not a uuid", async () => {
  const { read, calls } = setup([]);
  expect(await read("session", A, S, "nije-uuid")).toEqual({ status: "not_found" });
  expect(calls).toEqual([]);
});

it.each([
  ["ZD401", "unauthenticated"],
  ["ZD403", "not_found"],
  ["ZD409", "unavailable"],
  ["57014", "unavailable"],
])("maps %s to %s", async (code, status) => {
  expect(await setup(coded(code)).read("session", A, S, C)).toEqual({ status });
});

it.each([
  ["no row", []],
  ["a gap in seq", [msg(1), msg(3)]],
  ["fewer rows than throughSeq", [msg(1)]],
  ["an unknown role", [msg(1), msg(2, "teacher")]],
])("is unavailable for %s", async (_name, rows) => {
  expect(await setup(rows).read("session", A, S, C)).toEqual({ status: "unavailable" });
});
