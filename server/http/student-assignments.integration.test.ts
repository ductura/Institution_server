// GET /api/v1/student/assignments (SRV-09) on a real server with the real
// pipeline, over a fake port: the vectors the route answers as they are
// (ready-empty, signed-out, unavailable), and a ready body that the contract's
// own schema accepts, built from rows in the port's order. ready and
// ready-before-3 carry groups, teachers and a mentor, which the route leaves
// out until the read gives them (Ductus#2028 c.7009610321). All values are
// invented.
import { readFileSync } from "node:fs";
import { request as httpRequest } from "node:http";

import { Value } from "@sinclair/typebox/value";
import { afterEach, describe, expect, it } from "vitest";

import { ROUTES } from "../contracts/index.ts";
import type { StudentAssignmentRow, StudentAssignmentsRead } from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { type Running, startServer } from "./start.ts";
import { createStudentAssignmentsRoute } from "./student-assignments.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/student.assignments.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const vector = (name: string) => VECTORS.find((v) => v.name === name)!;
const HEADERS = vector("ready").request.headers!;
const SCHEMA = ROUTES.find((r) => r.id === "student.assignments.get")!.responses[0]!.body;

let server: Running | undefined;
const reads: string[] = [];

async function start(answer: () => Promise<StudentAssignmentsRead>) {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    databases: createDatabases(),
    routes: [
      createStudentAssignmentsRoute(async (token) => {
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
      { host: "127.0.0.1", port: server!.port, path: "/api/v1/student/assignments", headers },
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

const row = (over: Partial<StudentAssignmentRow>): StudentAssignmentRow => ({
  assignmentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01",
  courseId: "0b9f6c1e-1d2a-4c3b-8e4f-5a6b7c8d9e01",
  courseName: "Izmišljeni kolegij Č",
  academicYear: "2026/2027",
  title: "Izmišljeni zadatak 1",
  workType: "seminar_paper",
  dueAt: "2026-12-01T22:59:00.000Z",
  extendedDueAt: null,
  acknowledged: true,
  isPractice: false,
  ...over,
});

describe("GET /api/v1/student/assignments", () => {
  it("answers ready-empty, and a body of the contract's schema in the port's order", async () => {
    await start(async () => ({ status: "ok", rows: [] }));
    expect(await get(HEADERS)).toEqual({ status: 200, body: vector("ready-empty").response.body });
    await server!.close();

    const rows = [
      row({}),
      row({
        assignmentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02",
        acknowledged: false,
        isPractice: true,
      }),
      row({
        assignmentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e03",
        courseId: "0b9f6c1e-1d2a-4c3b-8e4f-5a6b7c8d9e02",
        courseName: "Izmišljeni kolegij D",
        workType: "essay",
        extendedDueAt: "2026-12-08T22:59:00.000Z",
      }),
    ];
    await start(async () => ({ status: "ok", rows }));
    const got = await get(HEADERS);
    expect(got.status).toBe(200);
    expect(Value.Check(SCHEMA as never, got.body)).toBe(true);
    const courses = got.body.courses as { id: string; assignments: { id: string }[] }[];
    expect(courses.map((c) => [c.id, c.assignments.map((a) => a.id.slice(-2))])).toEqual([
      ["0b9f6c1e-1d2a-4c3b-8e4f-5a6b7c8d9e01", ["01", "02"]],
      ["0b9f6c1e-1d2a-4c3b-8e4f-5a6b7c8d9e02", ["03"]],
    ]);
    expect(courses[0]).toEqual({
      id: "0b9f6c1e-1d2a-4c3b-8e4f-5a6b7c8d9e01",
      name: "Izmišljeni kolegij Č",
      academicYear: "2026/2027",
      assignments: [
        expect.objectContaining({ noticeFirst: false, extendedDueAt: null }),
        expect.objectContaining({ noticeFirst: true }),
      ],
    });
  });

  it("leaves isPractice out of the answer, the practice row included (VLAK-WEB934-ISPRACTICE)", async () => {
    await start(async () => ({
      status: "ok",
      rows: [
        row({}),
        row({ assignmentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02", isPractice: true }),
      ],
    }));
    const got = await get(HEADERS);
    expect(got.status).toBe(200);
    const courses = got.body.courses as { assignments: Record<string, unknown>[] }[];
    const assignments = courses.flatMap((c) => c.assignments);
    expect(assignments).toHaveLength(2);
    for (const a of assignments) expect(a).not.toHaveProperty("isPractice");
  });

  it.each([
    ["signed-out", async () => ({ status: "ok", rows: [] }) as const],
    ["unavailable", async () => ({ status: "unavailable" }) as const],
    ["unavailable", async () => ({ status: "ok", rows: [row({ workType: "poem" })] }) as const],
    ["unavailable", () => Promise.reject(new Error("izmišljeni kvar"))],
  ] as const)("answers the %s vector", async (name, answer) => {
    const v = vector(name);
    await start(answer as () => Promise<StudentAssignmentsRead>);
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
