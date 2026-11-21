import { createHash } from "node:crypto";

import { expect, it } from "vitest";

import type { WithActor } from "../index.ts";

import { createTeacherSubmissions } from "./index.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const STUDENT = "00000000-0000-4000-8000-0000000000b1";
const SUBMISSION = "00000000-0000-4000-8000-0000000000c1";
const DOCUMENT = '{"nodes":[],"schemaVersion":2}';
const HASH = createHash("sha256").update(DOCUMENT).digest("hex");
const REQUESTED_AT = "2026-11-21T12:01:00.000000Z";

function fixture(dueAt: string, late: boolean) {
  return {
    student_id: STUDENT,
    document_id: "demo-work",
    submitted: true,
    revision: "4",
    requested_minute: new Date(REQUESTED_AT),
    after_deadline: late,
    receipt: {
      submissionId: SUBMISSION,
      assignmentId: ASSIGNMENT,
      principalId: STUDENT,
      documentId: "demo-work",
      revision: 4,
      artifactSha256: HASH,
      requestedAt: REQUESTED_AT,
      dueAt,
      afterDeadline: late,
    },
  };
}

function setup(...answers: (object[] | Error)[]) {
  const calls: (readonly unknown[] | undefined)[] = [];
  const withActor: WithActor = async (_token, read) =>
    read({
      async query<Row>(_sql: string, params?: readonly unknown[]) {
        calls.push(params);
        const found = answers.shift();
        if (found instanceof Error) throw found;
        if (found === undefined) throw new Error("unexpected query");
        return { rows: found as Row[], rowCount: found.length };
      },
    });
  return { port: createTeacherSubmissions(withActor), calls };
}

it.each([
  ["2026-11-21T12:00:00.000000Z", true],
  [REQUESTED_AT, false],
  ["2026-11-21T12:02:00.000000Z", false],
] as const)("projects the stored lateness for the pinned deadline %s", async (dueAt, late) => {
  const { port } = setup([fixture(dueAt, late)]);
  expect(await port.list("session", ASSIGNMENT)).toMatchObject({
    status: "ok",
    body: {
      submissions: [{ studentId: STUDENT, revision: 4, afterDeadline: late }],
      submittedVersions: [{ studentId: STUDENT, submissionId: SUBMISSION, revision: 4, late }],
    },
  });
});

it("shows a recorded submission while its receipt is pending", async () => {
  const { port } = setup([{ ...fixture(REQUESTED_AT, false), receipt: null }]);
  expect(await port.list("session", ASSIGNMENT)).toMatchObject({
    status: "ok",
    body: { submittedVersions: [{ submissionId: null, late: false }] },
  });
});

it("returns exactly the recorded artifact and revision", async () => {
  const { port, calls } = setup(
    [fixture(REQUESTED_AT, false)],
    [{ outcome: "submitted", content_hash: HASH, body: DOCUMENT }],
  );
  expect(await port.detail("session", ASSIGNMENT, SUBMISSION)).toEqual({
    status: "ok",
    body: {
      submissionId: SUBMISSION,
      studentId: STUDENT,
      revision: 4,
      late: false,
      document: DOCUMENT,
    },
  });
  expect(calls).toEqual([
    [ASSIGNMENT, SUBMISSION],
    ["demo-work", null],
  ]);
});

it("returns 404 for an inaccessible pair without opening a work", async () => {
  const { port, calls } = setup([]);
  expect(await port.detail("session", ASSIGNMENT, SUBMISSION)).toEqual({ status: "not_found" });
  expect(calls).toEqual([[ASSIGNMENT, SUBMISSION]]);
});

it("honors a refusal when access changes before opening the work", async () => {
  const { port } = setup(
    [fixture(REQUESTED_AT, false)],
    Object.assign(new Error("refused"), { code: "ZD403" }),
  );
  expect(await port.detail("session", ASSIGNMENT, SUBMISSION)).toEqual({ status: "not_found" });
});

it.each([
  { outcome: "state", content_hash: HASH, body: DOCUMENT },
  { outcome: "submitted", content_hash: HASH, body: '{"nodes":[]}' },
  { outcome: "submitted", content_hash: "a".repeat(64), body: DOCUMENT },
])("does not serve bytes outside the submitted artifact", async (row) => {
  const { port } = setup([fixture(REQUESTED_AT, false)], [row]);
  expect(await port.detail("session", ASSIGNMENT, SUBMISSION)).toEqual({ status: "unavailable" });
});
