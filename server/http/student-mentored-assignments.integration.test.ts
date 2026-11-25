// GET /api/v1/student/mentored-assignments (INT-31, Ductus#2055) on a real
// server with the real pipeline, over a fake port: every vector of the route
// as it is, and a body the contract's own schema accepts, built from rows in
// the port's order. All values are invented.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import type {
  StudentMentoredAssignmentRow,
  StudentMentoredAssignmentsRead,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createStudentMentoredAssignmentsRoute } from "./student-assignments.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/student.mentored-assignments.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const vector = (name: string) => VECTORS.find((v) => v.name === name)!;
const HEADERS = vector("ready").request.headers!;
const SCHEMA = ROUTES.find((r) => r.id === "student.mentored-assignments.get")!.responses[0]!.body;

let server: Running | undefined;
const reads: string[] = [];

async function start(answer: () => Promise<StudentMentoredAssignmentsRead>) {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [
      createStudentMentoredAssignmentsRoute(async (token) => {
        reads.push(token);
        return answer();
      }),
    ],
  });
}
afterEach(async () => {
  reads.length = 0;
  await server?.close();
  server = undefined;
});

function get(headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port: server!.port,
        path: "/api/v1/student/mentored-assignments",
        headers,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}
const withoutRequestId = (body: Record<string, unknown>) =>
  Object.fromEntries(Object.entries(body).filter(([k]) => k !== "requestId"));

const row = (over: Partial<StudentMentoredAssignmentRow>): StudentMentoredAssignmentRow => ({
  assignmentId: "2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
  mentorshipId: "3c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
  title: "Izmišljeni završni rad",
  workType: "bachelor_thesis",
  dueAt: "2027-05-01T12:00:00.000Z",
  extendedDueAt: null,
  acknowledged: true,
  mentor: {
    id: "4c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
    givenName: "Izmišljena",
    familyName: "Mentorica",
  },
  ...over,
});

describe("GET /api/v1/student/mentored-assignments", () => {
  it("answers ready-empty, and a body of the contract's schema in the port's order", async () => {
    await start(async () => ({ status: "ok", rows: [] }));
    expect(await get(HEADERS)).toEqual({ status: 200, body: vector("ready-empty").response.body });
    await server!.close();

    const rows = [
      row({}),
      row({
        assignmentId: "2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02",
        workType: "master_thesis",
        extendedDueAt: "2027-06-01T12:00:00.000Z",
        acknowledged: false,
        mentor: null,
      }),
    ];
    await start(async () => ({ status: "ok", rows }));
    const got = await get(HEADERS);
    expect(got.status).toBe(200);
    expect(Value.Check(SCHEMA as never, got.body)).toBe(true);
    expect(got.body).toEqual({
      assignments: [
        {
          id: "2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
          mentorshipId: "3c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
          title: "Izmišljeni završni rad",
          dueAt: "2027-05-01T12:00:00.000Z",
          noticeFirst: false,
          workType: "bachelor_thesis",
          mentor: {
            id: "4c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
            givenName: "Izmišljena",
            familyName: "Mentorica",
          },
          extendedDueAt: null,
        },
        expect.objectContaining({
          id: "2c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02",
          noticeFirst: true,
          workType: "master_thesis",
          mentor: null,
          extendedDueAt: "2027-06-01T12:00:00.000Z",
        }),
      ],
    });
  });

  it("answers the ready vector from the rows it was built from", async () => {
    const ready = vector("ready").response.body as {
      assignments: {
        id: string;
        mentorshipId: string;
        title: string;
        dueAt: string;
        noticeFirst: boolean;
        workType: string;
        mentor: StudentMentoredAssignmentRow["mentor"];
        extendedDueAt: string | null;
      }[];
    };
    const rows = ready.assignments.map((a) => ({
      assignmentId: a.id,
      mentorshipId: a.mentorshipId,
      title: a.title,
      workType: a.workType,
      dueAt: a.dueAt,
      extendedDueAt: a.extendedDueAt,
      acknowledged: !a.noticeFirst,
      mentor: a.mentor,
    }));
    await start(async () => ({ status: "ok", rows }));
    expect(await get(HEADERS)).toEqual({ status: 200, body: ready });
  });

  it.each([
    ["signed-out", async () => ({ status: "ok", rows: [] }) as const],
    ["unavailable", async () => ({ status: "unavailable" }) as const],
    ["unavailable", async () => ({ status: "ok", rows: [row({ workType: "poem" })] }) as const],
    ["unavailable", () => Promise.reject(new Error("izmišljeni kvar"))],
  ] as const)("answers the %s vector", async (name, answer) => {
    const v = vector(name);
    await start(answer as () => Promise<StudentMentoredAssignmentsRead>);
    const got = await get(v.request.headers);
    expect(got.status).toBe(v.response.status);
    expect(withoutRequestId(got.body)).toEqual(withoutRequestId(v.response.body));
  });

  it("answers 401 when the port finds no session, and 403 cross-site without reading", async () => {
    await start(async () => ({ status: "unauthenticated" }));
    expect((await get(HEADERS)).status).toBe(401);
    expect((await get({ ...HEADERS, "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(reads).toHaveLength(1);
  });
});
