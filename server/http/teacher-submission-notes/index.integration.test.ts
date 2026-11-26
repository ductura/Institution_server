// GET /api/v1/teacher/assignments/{assignmentId}/students/{studentId}/submission-notes
// (SRV-F4-NAS-R11) on a real server over a fake reader: every contract vector,
// and 503 for a note the contract does not accept. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, expect, it, vi } from "vitest";

import type { TeacherSubmissionNotesReader } from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createTeacherSubmissionNotesRoute } from "./index.ts";

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
    new URL("../../contracts/vectors/teacher.submission-notes.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };
let running: Running | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function get(read: TeacherSubmissionNotesReader, vector: Vector) {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [createTeacherSubmissionNotesRoute(read)],
  });
  const { assignmentId, studentId } = vector.request.params;
  return fetch(
    `http://127.0.0.1:${running.port}/api/v1/teacher/assignments/${assignmentId}/students/${studentId}/submission-notes`,
    { ...(vector.request.headers === undefined ? {} : { headers: vector.request.headers }) },
  );
}

it.each(vectors.map((vector) => [vector.name, vector] as const))(
  "vector %s",
  async (_name, vector) => {
    const { status, body } = vector.response;
    const read = vi
      .fn<TeacherSubmissionNotesReader>()
      .mockResolvedValue(
        status === 200
          ? { status: "ok", body: body as { notes: [] } }
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

it("answers 503 for a note outside the contract", async () => {
  const vector = vectors.find((item) => item.name === "notes-oldest-first")!;
  const read = vi.fn<TeacherSubmissionNotesReader>().mockResolvedValue({
    status: "ok",
    body: { notes: [{ id: "not-an-id", text: "Izmišljena napomena.", createdAt: "2026-11-20" }] },
  });
  expect((await get(read, vector)).status).toBe(503);
});
