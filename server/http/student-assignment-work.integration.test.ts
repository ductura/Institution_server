import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MY_ASSIGNMENT_WORK_DATABASE_ERROR,
  MY_ASSIGNMENT_WORK_UNAUTHENTICATED,
  type AssignmentWork,
  type MyAssignmentWorkReader,
} from "../database/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import { startServer, type Running } from "./start.ts";
import { createStudentAssignmentWorkRoute } from "./student-assignment-work.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const { vectors } = JSON.parse(
  readFileSync(
    new URL("../contracts/vectors/student.assignment-work.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };
const token = "izmisljeni-token-popisa-radova-000000000001";
const cookie = `__Host-ductus_session=${token}`;
const assignmentId = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01";
const work = { assignmentId, workState: "in_progress" };
let running: Running | undefined;

async function start(read: MyAssignmentWorkReader["read"]): Promise<string> {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: "https://ductura.example.invalid" }),
    routes: [createStudentAssignmentWorkRoute({ read })],
  });
  return `http://127.0.0.1:${running.port}/api/v1/student/assignment-work`;
}

afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
});

describe("GET /api/v1/student/assignment-work", () => {
  it.each(vectors)("matches the $name contract vector", async ({ request, response }) => {
    const read = vi
      .fn<MyAssignmentWorkReader["read"]>()
      .mockResolvedValue(
        response.status === 503
          ? { ok: false, error: MY_ASSIGNMENT_WORK_DATABASE_ERROR }
          : { ok: true, value: response.body.assignments as AssignmentWork[] },
      );
    const url = await start(read);
    const got = await fetch(url, request.headers === undefined ? {} : { headers: request.headers });
    expect(got.status).toBe(response.status);
    expect(got.headers.get("content-type")).toMatch(/^application\/json\b/u);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(got.headers.get("set-cookie")).toBeNull();
    if (response.status === 200) {
      expect(await got.json()).toEqual(response.body);
    } else {
      expect(await got.json()).toEqual({
        ...response.body,
        requestId: got.headers.get("x-request-id"),
      });
    }
    expect(read.mock.calls).toEqual(response.status === 401 ? [] : [[token]]);
  });

  it("rejects a malformed or duplicate session cookie before reading", async () => {
    const read = vi.fn<MyAssignmentWorkReader["read"]>();
    const url = await start(read);
    for (const header of ["__Host-ductus_session=wrong", `${cookie}; ${cookie}`]) {
      expect((await fetch(url, { headers: { cookie: header } })).status).toBe(401);
    }
    expect(read).not.toHaveBeenCalled();
  });

  it("takes identity only from the session cookie and rejects an expired session", async () => {
    const read = vi.fn<MyAssignmentWorkReader["read"]>().mockResolvedValue({
      ok: false,
      error: MY_ASSIGNMENT_WORK_UNAUTHENTICATED,
    });
    const url = await start(read);
    const got = await fetch(`${url}?studentId=demo-other`, {
      headers: { cookie: `${cookie}; ductus_session=demo-other`, "x-student-id": "demo-other" },
    });
    expect(got.status).toBe(401);
    expect(read.mock.calls).toEqual([[token]]);
  });

  it("returns a generic 503 when the reader rejects", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const read = vi
      .fn<MyAssignmentWorkReader["read"]>()
      .mockRejectedValue(new Error("invented error"));
    const got = await fetch(await start(read), { headers: { cookie } });
    expect(got.status).toBe(503);
    expect(await got.json()).toMatchObject({ code: "unavailable" });
    expect(read.mock.calls).toEqual([[token]]);
  });

  it.each([
    ["a sparse list", Array(1)],
    ["an inherited row", [Object.create(work) as unknown]],
    ["an extra field", [{ ...work, title: "Izmišljeni naslov" }]],
    ["an invalid id", [{ ...work, assignmentId: `${assignmentId}\n` }]],
    ["an invalid state", [{ ...work, workState: "pending" }]],
    ["a duplicate assignment", [work, work]],
    ["an unordered list", [{ ...work, assignmentId: `${assignmentId.slice(0, -1)}2` }, work]],
    ["a proxy", new Proxy([work], {})],
    ["an unclonable field", [{ ...work, extra: () => work }]],
  ])("refuses %s without returning a partial response", async (_name, value) => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const url = await start(async () => ({ ok: true, value: value as AssignmentWork[] }));
    const got = await fetch(url, { headers: { cookie } });
    expect(got.status).toBe(503);
    const body: unknown = await got.json();
    expect(body).toMatchObject({ code: "unavailable" });
    expect(body).not.toHaveProperty("assignments");
  });
});
