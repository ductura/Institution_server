// GET .../declaration/conversations/{conversationId} (F4-NAS-R04-SRV) on a real
// server over a fake reader: every contract vector. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, expect, it, vi } from "vitest";

import type {
  TeacherDeclarationConversation,
  TeacherDeclarationConversationReader,
} from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createTeacherDeclarationConversationRoute } from "./conversation.ts";

const ORIGIN = "https://ductura.example.invalid";
type Vector = {
  name: string;
  request: {
    headers?: Record<string, string>;
    params: { assignmentId: string; studentId: string; conversationId: string };
  };
  response: { status: number; body: Record<string, unknown> };
};
const { vectors } = JSON.parse(
  readFileSync(
    new URL("../../contracts/vectors/teacher.declaration-conversation.get.json", import.meta.url),
    "utf8",
  ),
) as { vectors: Vector[] };
let running: Running | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function get(read: TeacherDeclarationConversationReader, vector: Vector) {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [createTeacherDeclarationConversationRoute(read)],
  });
  const { assignmentId, studentId, conversationId } = vector.request.params;
  return fetch(
    `http://127.0.0.1:${running.port}/api/v1/teacher/assignments/${assignmentId}/students/${studentId}/declaration/conversations/${conversationId}`,
    { ...(vector.request.headers === undefined ? {} : { headers: vector.request.headers }) },
  );
}

it.each(vectors.map((vector) => [vector.name, vector] as const))(
  "vector %s",
  async (_name, vector) => {
    const { status, body } = vector.response;
    const read = vi
      .fn<TeacherDeclarationConversationReader>()
      .mockResolvedValue(
        status === 200
          ? { status: "ok", body: body as TeacherDeclarationConversation }
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
        vector.request.params.conversationId,
      );
  },
);

it("answers 503 for a body outside the contract", async () => {
  const ok = vectors.find((vector) => vector.name === "attached-conversation")!;
  const read = vi.fn<TeacherDeclarationConversationReader>().mockResolvedValue({
    status: "ok",
    body: { ...(ok.response.body as TeacherDeclarationConversation), messagesSha256: "kratko" },
  });
  expect((await get(read, ok)).status).toBe(503);
});
