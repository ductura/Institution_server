import { Value } from "@sinclair/typebox/value";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { startServer, type Running } from "./start.ts";
import { createTeacherRosterRoutesFor } from "./teacher-roster.ts";

const ID = "00000000-0000-4000-8000-0000000000a1";
const STUDENT = "00000000-0000-4000-8000-0000000000b1";
const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ROSTER = `/api/v1/teacher/courses/${ID}/students`;
const OVERVIEW = `/api/v1/teacher/assignments/${ID}/overview`;
const FOLLOW_UP = `/api/v1/teacher/assignments/${ID}/follow-up`;
const student = { student_id: STUDENT, given_name: null, family_name: null, groupName: "Grupa B" };
const minute = new Date("2026-11-20T12:34:00.000Z");

const query = vi.fn();
const withActor: WithActor = (token, run) =>
  run({ query: query.bind(null, token) } as ActorTransaction);
const routes = createTeacherRosterRoutesFor({ withActor });
let server: Running;

beforeEach(async () => {
  query.mockReset().mockResolvedValue({ rows: [] });
  vi.spyOn(console, "error").mockImplementation(() => {});
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes,
  });
});
afterEach(async () => {
  await server.close();
  vi.restoreAllMocks();
});

function get(path: string, headers: Record<string, string> = { cookie: COOKIE }) {
  return fetch(`http://127.0.0.1:${server.port}${path}`, { headers });
}

describe.each([ROSTER, OVERVIEW, FOLLOW_UP])("%s", (path) => {
  it.each(["nije-uuid", "%ZZ", "%00", "%2530", "%2F", `${ID}%0A`])(
    "returns the same empty answer for malformed %s and for a database refusal",
    async (id) => {
      const invalid = await get(path.replace(ID, id));
      expect(query).not.toHaveBeenCalled();
      const empty = await get(path);
      expect(query).toHaveBeenCalledExactlyOnceWith(TOKEN, expect.any(String), [ID]);
      expect(invalid.status).toBe(200);
      expect(empty.status).toBe(200);
      expect(invalid.headers.get("cache-control")).toBe("no-store");
      expect(empty.headers.get("cache-control")).toBe("no-store");
      expect(await invalid.text()).toBe(await empty.text());
    },
  );

  it("decodes the path once and passes a lowercase UUID in one statement", async () => {
    expect((await get(path.replace(ID, `%30${ID.toUpperCase().slice(1)}`))).status).toBe(200);
    expect(query).toHaveBeenCalledExactlyOnceWith(TOKEN, expect.any(String), [ID]);
  });

  it.each([
    [{}, 401],
    [{ cookie: "malformed" }, 401],
    [{ cookie: COOKIE, "sec-fetch-site": "cross-site" }, 403],
    [{ cookie: COOKIE, "sec-fetch-site": "same-origin, same-origin" }, 403],
  ] satisfies [Record<string, string>, number][])(
    "refuses headers %j before SQL",
    async (headers, status) => {
      expect((await get(path, headers)).status).toBe(status);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ZD401", 401],
    ["57P01", 503],
  ])("maps database failure %s to %s", async (code, status) => {
    query.mockRejectedValue(Object.assign(new Error("invented private detail"), { code }));
    const answer = await get(path);
    expect(answer.status).toBe(status);
    expect(await answer.text()).not.toContain("invented private detail");
  });
});

it("returns a closed roster with work states and refuses duplicate assignment rows", async () => {
  const signed = {
    ...student,
    assignmentId: ID,
    documentId: "izmisljeni-rad",
    evidenceRecord: "continuous",
    title: null,
    workType: null,
  };
  query.mockResolvedValue({ rows: [signed] });
  const answer = await get(ROSTER);
  const body: unknown = await answer.json();
  expect(answer.status).toBe(200);
  expect(body).toEqual({
    students: [
      {
        studentId: STUDENT,
        givenName: null,
        familyName: null,
        groupName: "Grupa B",
        assignments: [{ assignmentId: ID, documentId: "izmisljeni-rad", workState: "submitted" }],
      },
    ],
  });
  expect(Value.Check(routes[0]!.contract.responses[0]!.body!, body)).toBe(true);
  query.mockResolvedValue({ rows: [signed, signed] });
  expect((await get(ROSTER)).status).toBe(503);
});

describe("assignment title and work type (DIZAJN-27-11 1.5)", () => {
  const STUDENT_2 = "00000000-0000-4000-8000-0000000000b2";
  const work = { assignmentId: ID, documentId: null, evidenceRecord: null };

  it.each([
    "short_paper",
    "essay",
    "seminar_paper",
    "bachelor_thesis",
    "master_thesis",
    "specialist_thesis",
    "doctoral_thesis",
  ])("returns the title and work type %s beside the work state", async (workType) => {
    query.mockResolvedValue({
      rows: [{ ...student, ...work, title: "Izmišljeni zadatak", workType }],
    });
    const answer = await get(ROSTER);
    const body: unknown = await answer.json();
    expect(answer.status).toBe(200);
    expect(body).toEqual({
      students: [
        {
          studentId: STUDENT,
          givenName: null,
          familyName: null,
          groupName: "Grupa B",
          assignments: [
            {
              assignmentId: ID,
              documentId: null,
              workState: "not_started",
              title: "Izmišljeni zadatak",
              workType,
            },
          ],
        },
      ],
    });
    expect(Value.Check(routes[0]!.contract.responses[0]!.body!, body)).toBe(true);
  });

  it("leaves both fields out when the assignment row is not readable", async () => {
    query.mockResolvedValue({ rows: [{ ...student, ...work, title: null, workType: null }] });
    const body = (await (await get(ROSTER)).json()) as {
      students: { assignments: Record<string, unknown>[] }[];
    };
    expect(Object.keys(body.students[0]!.assignments[0]!).sort()).toEqual([
      "assignmentId",
      "documentId",
      "workState",
    ]);
    expect(Value.Check(routes[0]!.contract.responses[0]!.body!, body)).toBe(true);
  });

  it.each([
    ["a title without a work type", { title: "Izmišljeni zadatak", workType: null }],
    ["a work type without a title", { title: null, workType: "essay" }],
    ["an empty title", { title: "", workType: "essay" }],
    ["an unknown work type", { title: "Izmišljeni zadatak", workType: "novel" }],
    ["a title that is not text", { title: 3, workType: "essay" }],
    ["missing columns", {}],
  ])("fails the entire roster for %s after a valid student", async (_, change) => {
    const valid = { ...student, ...work, title: "Izmišljeni zadatak", workType: "essay" };
    const other = { ...student, ...work, student_id: STUDENT_2, ...change };
    query.mockResolvedValue({ rows: [valid, other] });
    const answer = await get(ROSTER);
    expect(answer.status).toBe(503);
    expect(await answer.text()).not.toContain("Izmišljeni zadatak");
  });

  it("refuses a title on a student without any assignment", async () => {
    query.mockResolvedValue({
      rows: [
        { ...student, assignmentId: null, documentId: null, evidenceRecord: null, title: "Z" },
      ],
    });
    expect((await get(ROSTER)).status).toBe(503);
  });
});

it.each(["continuous", "with_gaps", null])(
  "returns the overview with evidenceRecord %s",
  async (evidenceRecord) => {
    query.mockResolvedValue({
      rows: [
        {
          ...student,
          submitted: true,
          requestedMinute: minute,
          afterDeadline: true,
          evidenceRecord,
          privateHash: "izmisljeni-otisak-koji-ne-izlazi",
        },
      ],
    });
    const answer = await get(OVERVIEW);
    const body: unknown = await answer.json();
    expect(answer.status).toBe(200);
    expect(body).toEqual({
      students: [
        {
          studentId: STUDENT,
          givenName: null,
          familyName: null,
          groupName: "Grupa B",
          submitted: true,
          requestedMinute: minute.toISOString(),
          afterDeadline: true,
          evidenceRecord,
        },
      ],
    });
    expect(Value.Check(routes[1]!.contract.responses[0]!.body!, body)).toBe(true);
  },
);

it("fails the entire overview for an invalid row after a valid one", async () => {
  const unsubmitted = {
    ...student,
    submitted: false,
    requestedMinute: null,
    afterDeadline: null,
    evidenceRecord: null,
  };
  query.mockResolvedValue({ rows: [unsubmitted] });
  const answer = await get(OVERVIEW);
  expect(answer.status).toBe(200);
  expect(Value.Check(routes[1]!.contract.responses[0]!.body!, await answer.json())).toBe(true);
  query.mockResolvedValue({
    rows: [unsubmitted, { ...unsubmitted, student_id: ID, requestedMinute: minute }],
  });
  expect((await get(OVERVIEW)).status).toBe(503);
});

describe("follow-up (SRV-NF4-POTVRDE-DORADE)", () => {
  const STUDENT_2 = "00000000-0000-4000-8000-0000000000b2";
  const window = new Date("2026-11-20T12:35:00.000Z");
  const full = {
    studentId: STUDENT,
    noticeReadMinute: minute,
    noticeAcknowledgedMinute: minute,
    noticeVersionNo: 2,
    revisionState: "responded",
    revisionChangedWindow: window,
    openRevisionCount: 1,
    instruction: "izmisljena-uputa-koja-ne-izlazi",
  };
  const none = {
    studentId: STUDENT_2,
    noticeReadMinute: null,
    noticeAcknowledgedMinute: null,
    noticeVersionNo: null,
    revisionState: null,
    revisionChangedWindow: null,
    openRevisionCount: 0,
  };

  // Database rows have snake_case columns; the test writes them in camelCase.
  const row = (fields: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [
        key.replace(/[A-Z]/gu, (c) => `_${c.toLowerCase()}`),
        value,
      ]),
    );

  it("returns closed rows with minutes, the five-minute window and nulls", async () => {
    query.mockResolvedValue({ rows: [row(full), row(none)] });
    const answer = await get(FOLLOW_UP);
    const body: unknown = await answer.json();
    expect(answer.status).toBe(200);
    expect(answer.headers.get("cache-control")).toBe("no-store");
    expect(body).toEqual({
      students: [
        {
          studentId: STUDENT,
          noticeReadAt: minute.toISOString(),
          noticeAcknowledgedAt: minute.toISOString(),
          noticeVersionNo: 2,
          revisionState: "responded",
          revisionChangedAt: window.toISOString(),
          openRevisionCount: 1,
        },
        {
          studentId: STUDENT_2,
          noticeReadAt: null,
          noticeAcknowledgedAt: null,
          noticeVersionNo: null,
          revisionState: null,
          revisionChangedAt: null,
          openRevisionCount: 0,
        },
      ],
    });
    expect(Value.Check(routes[2]!.contract.responses[0]!.body!, body)).toBe(true);
    expect(JSON.stringify(body)).not.toContain("izmisljena-uputa");
  });

  it.each([
    ["a second in the read minute", { noticeReadMinute: new Date("2026-11-20T12:34:01.000Z") }],
    ["text for a minute", { noticeReadMinute: minute.toISOString() }],
    ["an acknowledgment without a version", { noticeVersionNo: null }],
    ["a version without an acknowledgment", { noticeAcknowledgedMinute: null }],
    ["version 0", { noticeVersionNo: 0 }],
    ["a fractional version", { noticeVersionNo: 1.5 }],
    ["a window off five minutes", { revisionChangedWindow: minute }],
    ["a state without a window", { revisionChangedWindow: null }],
    ["a window without a state", { revisionState: null }],
    ["an unmapped state", { revisionState: "reopened" }],
    ["a negative count", { openRevisionCount: -1 }],
    ["a count as text", { openRevisionCount: "1" }],
    ["an uppercase id", { studentId: STUDENT.toUpperCase() }],
    ["a missing id", { studentId: null }],
  ])("fails the entire answer for %s after a valid row", async (_, change) => {
    query.mockResolvedValue({ rows: [row(none), row({ ...full, ...change })] });
    const answer = await get(FOLLOW_UP);
    expect(answer.status).toBe(503);
    expect(await answer.text()).not.toContain(STUDENT_2);
  });

  it("fails the entire answer for a repeated student", async () => {
    query.mockResolvedValue({ rows: [row(full), row({ ...none, studentId: STUDENT })] });
    expect((await get(FOLLOW_UP)).status).toBe(503);
  });

  it("asks only app.assignment_follow_up for the path's assignment", async () => {
    await get(FOLLOW_UP);
    expect(query).toHaveBeenCalledExactlyOnceWith(
      TOKEN,
      expect.stringContaining("FROM app.assignment_follow_up($1::uuid)"),
      [ID],
    );
  });
});
