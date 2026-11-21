import { readFileSync } from "node:fs";

import { afterEach, expect, it, vi } from "vitest";

import type { TeacherSubmissions } from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createTeacherSubmissionDetailRoute } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
type Vector = {
  name: string;
  request: {
    headers?: Record<string, string>;
    params: { assignmentId: string; submissionId: string };
  };
  response: { status: number; body: Record<string, unknown> };
};
const { vectors } = JSON.parse(
  readFileSync(
    new URL("../../contracts/vectors/teacher.submission-detail.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };
let running: Running | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

it.each(vectors.map((vector) => [vector.name, vector] as const))(
  "vector %s",
  async (_name, vector) => {
    const { status, body } = vector.response;
    const read = vi.fn<TeacherSubmissions["detail"]>().mockResolvedValue(
      status === 200
        ? {
            status: "ok",
            body: body as Extract<
              Awaited<ReturnType<TeacherSubmissions["detail"]>>,
              { status: "ok" }
            >["body"],
          }
        : { status: status === 404 ? "not_found" : "unavailable" },
    );
    running = await startServer({
      host: "127.0.0.1",
      port: 0,
      databases: createDatabases(),
      layers: createLayers({ expectedOrigin: ORIGIN }),
      routes: [createTeacherSubmissionDetailRoute(read)],
    });
    const { assignmentId, submissionId } = vector.request.params;
    const response = await fetch(
      `http://127.0.0.1:${running.port}/api/v1/teacher/assignments/${assignmentId}/submissions/${submissionId}`,
      { ...(vector.request.headers === undefined ? {} : { headers: vector.request.headers }) },
    );
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(
      status === 200 ? body : { ...body, requestId: response.headers.get("x-request-id") },
    );
    expect(read).toHaveBeenCalledTimes(status === 401 || status === 403 ? 0 : 1);
    if (status === 200)
      expect(read).toHaveBeenCalledWith(expect.any(String), assignmentId, submissionId);
  },
);
