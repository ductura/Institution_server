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

describe.each([ROSTER, OVERVIEW])("%s", (path) => {
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
