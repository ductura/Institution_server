import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { ROUTES } from "../../contracts/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createWorkTeamRoutesFor } from "./index.ts";

// The routes over a scripted database: shape checks, the refusals of the RPCs and
// the answers they become, the one order of names and the one body of the
// contribution. Who may do what is the database's (db/main/tests/248-work-team.sql).
// Everything here is invented.
const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "t".repeat(43);
const ASSIGNMENT = "00000000-0000-4000-8000-0000000019a1";
const TEAM = "00000000-0000-4000-8000-0000000019b1";
const OTHER_TEAM = "00000000-0000-4000-8000-0000000019b2";
const S1 = "00000000-0000-4000-8000-0000000019d1";
const S2 = "00000000-0000-4000-8000-0000000019d2";
const S3 = "00000000-0000-4000-8000-0000000019d3";
const S4 = "00000000-0000-4000-8000-0000000019d4";
const S5 = "00000000-0000-4000-8000-0000000019d5";
const S6 = "00000000-0000-4000-8000-0000000019d6";
const STUDENT = "00000000-0000-4000-8000-0000000019c1";
const query = vi.fn<(sql: string, values?: readonly unknown[]) => unknown[]>();
const withActor: WithActor = (token, run) =>
  run({
    query: async (sql, values) => {
      expect(token).toBe(TOKEN);
      const rows = sql.includes("identity.touch_current_session") ? [] : query(sql, values);
      return { rows, rowCount: rows.length };
    },
  } as ActorTransaction);
const refuse = (code: string) => Object.assign(new Error("refused"), { code });
const parts = (state: "ready" | "pending" | "failed") => (): never[] | unknown => {
  if (state === "ready") {
    return [
      {
        id: "b",
        givenName: "Ivo",
        familyName: "Zorić",
        part: { state, codePoints: { written: 90000 } },
      },
      {
        id: "a",
        givenName: "Ana",
        familyName: "Babić",
        part: { state, codePoints: { written: 3 } },
      },
    ];
  }
  return [{ id: "a", givenName: "Ana", familyName: "Babić", part: { state } }];
};

let running: Running;
let withSource: Running;
let readParts = vi.fn();
beforeAll(async () => {
  const base = {
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
  };
  running = await startServer({ ...base, routes: createWorkTeamRoutesFor({ withActor }) });
  readParts = vi.fn(parts("ready"));
  withSource = await startServer({
    ...base,
    routes: createWorkTeamRoutesFor(
      { withActor },
      {
        enabled: true,
        readParts: async (...args: unknown[]) => readParts(...args) as never,
      },
    ),
  });
});
afterAll(async () => {
  await running.close();
  await withSource.close();
});
beforeEach(() => {
  query.mockReset();
  readParts.mockReset();
  readParts.mockImplementation(parts("ready"));
});

function call(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    cookie?: string;
    contentType?: string;
    on?: Running;
  } = {},
) {
  const { method = options.body === undefined ? "GET" : "POST", body, cookie = TOKEN } = options;
  return fetch(`http://127.0.0.1:${(options.on ?? running).port}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie: `__Host-ductus_session=${cookie}` } : {}),
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": options.contentType ?? "application/json",
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
const problem = async (response: Response) => ({
  status: response.status,
  code: ((await response.json()) as { code: string }).code,
});
const STUDENT_BASE = `/api/v1/student/assignments/${ASSIGNMENT.toUpperCase()}`;
const TEACHER_BASE = `/api/v1/teacher/assignments/${ASSIGNMENT}`;
const SETTING = `/api/v1/institution/assignments/${ASSIGNMENT}/team-setting`;

it("answers a missing session with 401 and never reads the database", async () => {
  for (const path of [`${STUDENT_BASE}/team`, `${TEACHER_BASE}/teams`, SETTING]) {
    expect((await call(path, { cookie: "" })).status).toBe(401);
  }
  expect(
    (await call(`${STUDENT_BASE}/team`, { body: { action: "create" }, cookie: "" })).status,
  ).toBe(401);
  expect(query).not.toHaveBeenCalled();
});

it("reads a malformed assignment or team in the path as the same 404, without the database", async () => {
  for (const path of [
    "/api/v1/student/assignments/not-an-id/team",
    "/api/v1/teacher/assignments/not-an-id/teams",
    `${TEACHER_BASE}/teams/not-an-id/contribution`,
    "/api/v1/student/assignments/not-an-id/team/contribution",
  ]) {
    expect(await problem(await call(path))).toEqual({ status: 404, code: "not_found" });
  }
  expect(
    await problem(
      await call(`${TEACHER_BASE}/teams/not-an-id/members`, {
        body: { studentId: STUDENT, action: "add" },
      }),
    ),
  ).toEqual({ status: 404, code: "not_found" });
  expect(query).not.toHaveBeenCalled();
});

it("refuses a bad body before the database: media type, JSON, shape, sizes, ids and actions", async () => {
  const put = (body: unknown, contentType?: string) =>
    call(SETTING, { method: "PUT", body, ...(contentType ? { contentType } : {}) });
  expect((await put({}, "text/plain")).status).toBe(415);
  const broken = await fetch(`http://127.0.0.1:${running.port}${SETTING}`, {
    method: "PUT",
    headers: {
      cookie: `__Host-ductus_session=${TOKEN}`,
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body: "{",
  });
  expect(await problem(broken)).toEqual({ status: 400, code: "invalid_json" });
  const good = { enabled: true, minSize: 2, maxSize: 4, formation: "student_choice" };
  for (const bad of [
    { ...good, minSize: 1 },
    { ...good, maxSize: 7 },
    { ...good, minSize: 5, maxSize: 3 },
    { ...good, formation: "random" },
    { ...good, extra: 1 },
    { enabled: true },
  ]) {
    expect(await problem(await put(bad))).toEqual({ status: 422, code: "invalid_input" });
  }
  for (const bad of [
    { action: "join" },
    { action: "join", teamId: "x" },
    { action: "create", teamId: TEAM },
    { action: "kick" },
  ]) {
    expect(await problem(await call(`${STUDENT_BASE}/team`, { body: bad }))).toEqual({
      status: 422,
      code: "invalid_input",
    });
  }
  for (const bad of [
    { studentId: "x", action: "add" },
    { studentId: STUDENT, action: "ban" },
  ]) {
    expect(
      await problem(await call(`${TEACHER_BASE}/teams/${TEAM}/members`, { body: bad })),
    ).toEqual({ status: 422, code: "invalid_input" });
  }
  expect(query).not.toHaveBeenCalled();
});

it("turns the refusals of the RPCs into 404, 409, 422 and a failure into 503", async () => {
  query.mockImplementation(() => {
    throw refuse("ZD404");
  });
  expect(await problem(await call(`${STUDENT_BASE}/team`))).toEqual({
    status: 404,
    code: "not_found",
  });
  query.mockImplementation(() => {
    throw refuse("ZD409");
  });
  expect(await problem(await call(`${STUDENT_BASE}/team`, { body: { action: "create" } }))).toEqual(
    {
      status: 409,
      code: "conflict",
    },
  );
  expect(
    await problem(await call(`${TEACHER_BASE}/teams`, { body: undefined, method: "POST" })),
  ).toEqual({
    status: 409,
    code: "conflict",
  });
  query.mockImplementation(() => {
    throw refuse("ZD422");
  });
  expect(
    await problem(
      await call(SETTING, {
        method: "PUT",
        body: { enabled: true, minSize: 2, maxSize: 4, formation: "student_choice" },
      }),
    ),
  ).toEqual({ status: 422, code: "invalid_input" });
  query.mockImplementation(() => {
    throw new Error("down");
  });
  expect(await problem(await call(`${STUDENT_BASE}/team`))).toEqual({
    status: 503,
    code: "unavailable",
  });
});

it("gives the setting and the student's team state in the shape of the contract", async () => {
  query.mockImplementation((sql) => {
    if (sql.includes("assignment_team_setting")) {
      return [{ enabled: true, minSize: 2, maxSize: 4, formation: "teacher_assigned" }];
    }
    return [
      {
        rowKind: "member",
        formation: "student_choice",
        teamId: TEAM,
        memberCount: null,
        givenName: "Ivo",
        familyName: "Zorić",
      },
      {
        rowKind: "member",
        formation: "student_choice",
        teamId: TEAM,
        memberCount: null,
        givenName: "Ana",
        familyName: "Babić",
      },
    ];
  });
  expect(await (await call(SETTING)).json()).toEqual({
    enabled: true,
    minSize: 2,
    maxSize: 4,
    formation: "teacher_assigned",
  });
  expect(await (await call(`${STUDENT_BASE}/team`)).json()).toEqual({
    state: "member",
    team: {
      teamId: TEAM,
      members: [
        { givenName: "Ana", familyName: "Babić" },
        { givenName: "Ivo", familyName: "Zorić" },
      ],
    },
  });
  query.mockImplementation(() => [
    {
      rowKind: "none",
      formation: "student_choice",
      teamId: null,
      memberCount: null,
      givenName: null,
      familyName: null,
    },
    {
      rowKind: "open",
      formation: "student_choice",
      teamId: TEAM,
      memberCount: 2,
      givenName: null,
      familyName: null,
    },
  ]);
  expect(await (await call(`${STUDENT_BASE}/team`)).json()).toEqual({
    state: "none",
    formation: "student_choice",
    openTeams: [{ teamId: TEAM, memberCount: 2 }],
  });
  query.mockImplementation(() => [
    {
      rowKind: "disabled",
      formation: "student_choice",
      teamId: null,
      memberCount: null,
      givenName: null,
      familyName: null,
    },
  ]);
  expect(await (await call(`${STUDENT_BASE}/team`)).json()).toEqual({ state: "disabled" });
});

it("shows no name to a student who is not in a team, and a member without a name reads as unavailable", async () => {
  query.mockImplementation(() => [
    {
      rowKind: "member",
      formation: "student_choice",
      teamId: TEAM,
      memberCount: null,
      givenName: null,
      familyName: "Babić",
    },
  ]);
  expect((await call(`${STUDENT_BASE}/team`)).status).toBe(503);
});

it("lists teams alphabetically whatever order the database gives, and never by an amount", async () => {
  const row = (
    teamId: string | null,
    studentId: string | null,
    givenName: string,
    familyName: string,
    workState = "submitted",
  ) => ({
    teamId,
    studentId,
    givenName,
    familyName,
    workState,
  });
  query.mockImplementation(() => [
    row(OTHER_TEAM, S4, "Pero", "Šimić"),
    row(OTHER_TEAM, S3, "Eva", "Šimić"),
    row(TEAM, S2, "Ivo", "Zorić", "in_progress"),
    row(TEAM, S1, "Ana", "Babić", "not_started"),
    row(null, S6, "Zvonko", "Alić", null as never),
    row(null, S5, "Ana", "Alić", null as never),
  ]);
  const body = (await (await call(`${TEACHER_BASE}/teams`)).json()) as {
    teams: { teamId: string; members: { studentId: string; workState: string }[] }[];
    unassigned: { studentId: string }[];
  };
  expect(body.teams.map((team) => team.teamId)).toEqual([TEAM, OTHER_TEAM]);
  expect(body.teams[0]?.members.map((m) => m.studentId)).toEqual([S1, S2]);
  expect(body.teams[1]?.members.map((m) => m.studentId)).toEqual([S3, S4]);
  expect(body.teams[0]?.members.map((m) => m.workState)).toEqual(["not_started", "in_progress"]);
  expect(body.unassigned.map((s) => s.studentId)).toEqual([S5, S6]);
});

it("creates a team and changes members through the RPCs", async () => {
  query.mockImplementation((sql) => (sql.includes("teacher_create_team") ? [{ id: TEAM }] : []));
  const created = await call(`${TEACHER_BASE}/teams`, { method: "POST" });
  expect(created.status).toBe(201);
  expect(await created.json()).toEqual({ teamId: TEAM });
  const moved = await call(`${TEACHER_BASE}/teams/${TEAM}/members`, {
    body: { studentId: STUDENT.toUpperCase(), action: "remove" },
  });
  expect(await moved.json()).toEqual({ updated: true });
  expect(query).toHaveBeenLastCalledWith(expect.stringContaining("teacher_team_member"), [
    ASSIGNMENT,
    TEAM,
    STUDENT,
    "remove",
  ]);
});

it("reads the contribution as disabled while there is no stored record, for both roles", async () => {
  query.mockImplementation((sql) =>
    sql.includes("student_team")
      ? [
          {
            rowKind: "member",
            formation: "student_choice",
            teamId: TEAM,
            memberCount: null,
            givenName: "Ana",
            familyName: "Babić",
          },
        ]
      : [
          {
            teamId: TEAM,
            studentId: S1,
            givenName: "Ana",
            familyName: "Babić",
            workState: "submitted",
          },
        ],
  );
  expect(await (await call(`${STUDENT_BASE}/team/contribution`)).json()).toEqual({
    state: "disabled",
  });
  expect(await (await call(`${TEACHER_BASE}/teams/${TEAM}/contribution`)).json()).toEqual({
    state: "disabled",
  });
});

it("reads another's or unknown team contribution as 404 for the teacher", async () => {
  query.mockImplementation(() => [
    {
      teamId: TEAM,
      studentId: S1,
      givenName: "Ana",
      familyName: "Babić",
      workState: "submitted",
    },
  ]);
  expect(
    await problem(
      await call(`${TEACHER_BASE}/teams/${OTHER_TEAM}/contribution`, { on: withSource }),
    ),
  ).toEqual({ status: 404, code: "not_found" });
  expect(readParts).not.toHaveBeenCalled();
});

it("gives the student and the teacher the same bytes, alphabetical, with the notice and no share", async () => {
  query.mockImplementation((sql) =>
    sql.includes("assignment_team_setting")
      ? [{ enabled: true, minSize: 2, maxSize: 4, formation: "student_choice" }]
      : sql.includes("student_team")
        ? [
            {
              rowKind: "member",
              formation: "student_choice",
              teamId: TEAM,
              memberCount: null,
              givenName: "Ana",
              familyName: "Babić",
            },
          ]
        : [
            {
              teamId: TEAM,
              studentId: S1,
              givenName: "Ana",
              familyName: "Babić",
              workState: "submitted",
            },
          ],
  );
  const student = await (
    await call(`${STUDENT_BASE}/team/contribution`, { on: withSource })
  ).text();
  const teacher = await (
    await call(`${TEACHER_BASE}/teams/${TEAM}/contribution`, { on: withSource })
  ).text();
  expect(student).toBe(teacher);
  const body = JSON.parse(student) as {
    state: string;
    notice: string;
    members: { familyName: string; totalCodePoints: number }[];
  };
  expect(body.state).toBe("ready");
  expect(body.notice).toBe("not_authorship_evidence");
  // The member with the smaller amount is first: the order is of the names.
  expect(body.members.map((m) => [m.familyName, m.totalCodePoints])).toEqual([
    ["Babić", 3],
    ["Zorić", 90000],
  ]);
  for (const word of ["share", "percent", "rank", "average", "threshold"]) {
    expect(student).not.toContain(word);
  }
  readParts.mockImplementation(parts("pending"));
  expect(
    await (await call(`${STUDENT_BASE}/team/contribution`, { on: withSource })).json(),
  ).toEqual({ state: "pending" });
  readParts.mockImplementation(parts("failed"));
  const failed = await (
    await call(`${TEACHER_BASE}/teams/${TEAM}/contribution`, { on: withSource })
  ).json();
  expect(failed).toEqual({ state: "failed" });
});

it("says none to a student without a team when records are kept", async () => {
  query.mockImplementation(() => [
    {
      rowKind: "none",
      formation: "student_choice",
      teamId: null,
      memberCount: null,
      givenName: null,
      familyName: null,
    },
  ]);
  expect(
    await (await call(`${STUDENT_BASE}/team/contribution`, { on: withSource })).json(),
  ).toEqual({ state: "none" });
  expect(readParts).not.toHaveBeenCalled();
});

it("carries the contribution on no route but the two contribution routes", () => {
  const holders = ROUTES.filter(
    (route) =>
      JSON.stringify(route.responses.map((response) => response.body ?? null)).includes(
        "not_authorship_evidence",
      ) &&
      JSON.stringify(route.responses.map((response) => response.body ?? null)).includes(
        "totalCodePoints",
      ),
  ).map((route) => route.id);
  expect(holders.sort()).toEqual([
    "student.work-team-contribution.get",
    "teacher.work-team-contribution.get",
  ]);
});

it("reads disabled for the teacher too once the teams are switched off, as the student does", async () => {
  query.mockImplementation((sql) =>
    sql.includes("assignment_team_setting")
      ? [{ enabled: false, minSize: 2, maxSize: 4, formation: "student_choice" }]
      : sql.includes("student_team")
        ? [
            {
              rowKind: "disabled",
              formation: "student_choice",
              teamId: null,
              memberCount: null,
              givenName: null,
              familyName: null,
            },
          ]
        : [
            {
              teamId: TEAM,
              studentId: S1,
              givenName: "Ana",
              familyName: "Babić",
              workState: "submitted",
            },
          ],
  );
  const student = await (
    await call(`${STUDENT_BASE}/team/contribution`, { on: withSource })
  ).text();
  const teacher = await (
    await call(`${TEACHER_BASE}/teams/${TEAM}/contribution`, { on: withSource })
  ).text();
  expect(teacher).toBe(student);
  expect(JSON.parse(teacher)).toEqual({ state: "disabled" });
  expect(readParts).not.toHaveBeenCalled();
});
