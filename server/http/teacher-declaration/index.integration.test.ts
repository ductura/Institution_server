// GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/declaration
// (SRV-1213) on a real server over a fake reader: every contract vector, and
// 503 for a bound payload the contract does not accept. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, expect, it, vi } from "vitest";

import type { TeacherDeclaration, TeacherDeclarationReader } from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createTeacherDeclarationRoute } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
type Vector = {
  name: string;
  request: {
    headers?: Record<string, string>;
    params: { assignmentId: string; studentId: string };
  };
  response: { status: number; body: Record<string, unknown> };
};
const { vectors } = JSON.parse(
  readFileSync(
    new URL("../../contracts/vectors/teacher.declaration.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };
let running: Running | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function get(read: TeacherDeclarationReader, vector: Vector) {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [createTeacherDeclarationRoute(read)],
  });
  const { assignmentId, studentId } = vector.request.params;
  return fetch(
    `http://127.0.0.1:${running.port}/api/v1/teacher/assignments/${assignmentId}/students/${studentId}/declaration`,
    { ...(vector.request.headers === undefined ? {} : { headers: vector.request.headers }) },
  );
}

it.each(vectors.map((vector) => [vector.name, vector] as const))(
  "vector %s",
  async (_name, vector) => {
    const { status, body } = vector.response;
    const read = vi
      .fn<TeacherDeclarationReader>()
      .mockResolvedValue(
        status === 200
          ? { status: "ok", body: body as TeacherDeclaration }
          : { status: status === 404 ? "not_found" : "unavailable" },
      );
    const response = await get(read, vector);
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(
      status === 200 ? body : { ...body, requestId: response.headers.get("x-request-id") },
    );
    expect(read).toHaveBeenCalledTimes(status === 401 || status === 403 ? 0 : 1);
    if (status === 200)
      expect(read).toHaveBeenCalledWith(
        expect.any(String),
        vector.request.params.assignmentId,
        vector.request.params.studentId,
      );
  },
);

it("answers 503 for a bound payload outside the contract", async () => {
  const bound = vectors.find((vector) => vector.name === "bound-declaration")!;
  const payload = { ...(bound.response.body.payload as object), declarationSchema: "other" };
  const read = vi.fn<TeacherDeclarationReader>().mockResolvedValue({
    status: "ok",
    body: { state: "bound", payload, declarationSha256: "b".repeat(64) },
  });
  const response = await get(read, bound);
  expect(response.status).toBe(503);
});

// SRV-IZJAVA-AI-UNBOUND: ai.unbound passes on v3 only; v1 and v2 stay closed.
const third = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/teacher.declaration-third.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors.find((vector) => vector.name === "bound-with-unbound-transfers")!;

it.each([
  ["teacher.declaration-third.get", "declaration-v3", 200],
  ["teacher.declaration-second.get", "declaration-v2", 503],
] as const)("SRV-IZJAVA-AI-UNBOUND: %s answers %i for ai.unbound", async (id, path, status) => {
  const read = vi
    .fn<TeacherDeclarationReader>()
    .mockResolvedValue({ status: "ok", body: third.response.body as TeacherDeclaration });
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [createTeacherDeclarationRoute(read, id)],
  });
  const { assignmentId, studentId } = third.request.params;
  const response = await fetch(
    `http://127.0.0.1:${running.port}/api/v1/teacher/assignments/${assignmentId}/students/${studentId}/${path}`,
    { ...(third.request.headers === undefined ? {} : { headers: third.request.headers }) },
  );
  expect(response.status).toBe(status);
  if (status === 200) expect(await response.json()).toEqual(third.response.body);
});
