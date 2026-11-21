import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import type { WithActor } from "../index.ts";
import { createTeacherSubmissionReader } from "./index.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const STUDENT = "00000000-0000-4000-8000-0000000000b1";
const DOCUMENT = '{"nodes":[],"schemaVersion":2}';
const HASH = createHash("sha256").update(DOCUMENT).digest("hex");
const SUBMITTED_CONTENT = { outcome: "submitted", content_hash: HASH, body: DOCUMENT };

function fixture(late: boolean) {
  return {
    student_id: STUDENT,
    document_id: "demo-work",
    submitted: true,
    revision: "4",
    requested_minute: new Date("2026-11-21T12:01:00.000Z"),
    after_deadline: late,
  };
}

function setup(...answers: (object[] | Error)[]) {
  const calls: (readonly unknown[] | undefined)[] = [];
  const withActor: WithActor = async (_token, run) =>
    run({
      async query<Row>(_sql: string, params?: readonly unknown[]) {
        calls.push(params);
        const found = answers.shift();
        if (found instanceof Error) throw found;
        if (found === undefined) throw new Error("unexpected query");
        return { rows: found as Row[], rowCount: found.length };
      },
    });
  return { read: createTeacherSubmissionReader(withActor), calls };
}

it.each([true, false])("returns the immutable revision and stored late=%s", async (late) => {
  const { read, calls } = setup([fixture(late)], [SUBMITTED_CONTENT]);
  expect(await read("session", ASSIGNMENT.toUpperCase(), STUDENT)).toEqual({
    status: "ok",
    body: { studentId: STUDENT, revision: 4, late, document: DOCUMENT },
  });
  expect(calls).toEqual([
    [ASSIGNMENT, STUDENT],
    ["demo-work", null],
  ]);
});

it.each([
  ["absent", []],
  ["inaccessible", Object.assign(new Error("refused"), { code: "ZD403" })],
] as [string, object[] | Error][])("returns 404 for an %s submission", async (_case, answer) => {
  const { read, calls } = setup(answer);
  expect(await read("session", ASSIGNMENT, STUDENT)).toEqual({ status: "not_found" });
  expect(calls).toEqual([[ASSIGNMENT, STUDENT]]);
});

it.each([
  ["nije-uuid", STUDENT],
  [ASSIGNMENT, "%2F"],
] as const)(
  "leaves the database uncalled for malformed IDs %s and %s",
  async (assignmentId, studentId) => {
    const { read, calls } = setup();
    expect(await read("session", assignmentId, studentId)).toEqual({ status: "not_found" });
    expect(calls).toEqual([]);
  },
);

it("honors a refusal when access changes before opening the work", async () => {
  const { read } = setup([fixture(false)], Object.assign(new Error("refused"), { code: "ZD403" }));
  expect(await read("session", ASSIGNMENT, STUDENT)).toEqual({ status: "not_found" });
});

it.each([
  { ...SUBMITTED_CONTENT, outcome: "state" },
  { ...SUBMITTED_CONTENT, body: '{"nodes":[]}' },
  { ...SUBMITTED_CONTENT, content_hash: "a".repeat(64) },
])("does not serve bytes outside the recorded artifact", async (row) => {
  const { read } = setup([fixture(false)], [row]);
  expect(await read("session", ASSIGNMENT, STUDENT)).toEqual({ status: "unavailable" });
});
