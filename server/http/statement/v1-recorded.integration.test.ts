// SRV-1809: a declaration confirmed with a transfer record in ai.recorded is
// answered 200 by the declaration-v1 routes with recorded: [], and by the v2
// routes with the list; the port's answer, as stored, keeps the list. All
// values are invented.
import { readFileSync } from "node:fs";

import { afterEach, expect, it, vi } from "vitest";

import type { TeacherDeclaration, TeacherDeclarationReader } from "../../database/index.ts";

import { createDatabases, createLayers, startServer, type Running, type Route } from "../index.ts";
import { createTeacherDeclarationRoute } from "../teacher-declaration/index.ts";
import { createStatementRoutes, type StatementPort } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const HEADERS = {
  cookie: `__Host-ductus_session=${"V".repeat(43)}`,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
};
const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const STUDENT = "00000000-0000-4000-8000-0000000000b1";
const LINK = {
  aiTransferId: "00000000-0000-4000-8000-0000000000c1",
  aiTransferSha256: "d".repeat(64),
};

type Vector = { name: string; response: { status: number; body: Record<string, unknown> } };
const vectors = (file: string) =>
  (
    JSON.parse(
      readFileSync(new URL(`../../contracts/vectors/${file}`, import.meta.url), "utf8"),
    ) as { vectors: Vector[] }
  ).vectors;
const bound = vectors("teacher.declaration.get.json").find((v) => v.name === "bound-declaration")!
  .response.body;
const boundPayload = bound.payload as Record<string, unknown> & { ai: Record<string, unknown> };
const payload = { ...boundPayload, ai: { ...boundPayload.ai, recorded: [LINK] } };
const statement = {
  ...vectors("student.declaration.get.json").find((v) => v.name === "success")!.response.body,
  state: "confirmed",
  draft: null,
  payload,
  declarationSha256: bound.declarationSha256,
};
const BODY = {
  baseVersion: 0,
  revision: 1,
  form: { formId: "test-izjava", formVersion: 1, formSha256: "a".repeat(64) },
  ownWork: { confirmed: true },
  humanHelp: { received: false, entries: [] },
  ai: { use: "used", declaredTools: [], attachments: [], externalAttachmentIds: [] },
  confirm: true,
};

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(routes: Route[]) {
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes,
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}

it.each([
  ["v1 GET", "GET", "declaration", []],
  ["v1 PUT", "PUT", "declaration", []],
  ["v2 GET", "GET", "declaration-v2", [LINK]],
  ["v2 PUT", "PUT", "declaration-v2", [LINK]],
] as const)(
  "student %s answers 200 with its recorded list",
  async (_name, method, path, recorded) => {
    const answer = structuredClone(statement);
    const run = vi.fn<StatementPort["run"]>().mockResolvedValue({ status: "ok", body: answer });
    const base = await serve(
      createStatementRoutes({ institutionSlug: async () => "demo-fakultet", run }),
    );
    const response = await fetch(`${base}/student/assignments/${ASSIGNMENT}/${path}`, {
      method,
      headers: { ...HEADERS, ...(method === "PUT" ? { "content-type": "application/json" } : {}) },
      ...(method === "PUT" ? { body: JSON.stringify(BODY) } : {}),
    });
    expect(response.status).toBe(200);
    const body = (await response.json()) as typeof statement;
    expect(body.payload.ai.recorded).toEqual(recorded);
    expect(body).toEqual({
      ...statement,
      payload: { ...payload, ai: { ...payload.ai, recorded } },
    });
    // The save sends no list of its own, and the stored answer keeps it.
    if (method === "PUT")
      expect(run).toHaveBeenCalledWith(expect.any(String), ASSIGNMENT, "demo-fakultet", {
        type: "save",
        body: BODY,
        answer: null,
      });
    expect(answer.payload.ai.recorded).toEqual([LINK]);
  },
);

it.each([
  ["teacher.declaration.get", "declaration", []],
  ["teacher.declaration-second.get", "declaration-v2", [LINK]],
] as const)("%s answers 200 with its recorded list", async (id, path, recorded) => {
  const answer = structuredClone({ ...bound, payload }) as unknown as TeacherDeclaration;
  const read = vi.fn<TeacherDeclarationReader>().mockResolvedValue({ status: "ok", body: answer });
  const base = await serve([createTeacherDeclarationRoute(read, id)]);
  const response = await fetch(
    `${base}/teacher/assignments/${ASSIGNMENT}/students/${STUDENT}/${path}`,
    { headers: { cookie: HEADERS.cookie, "sec-fetch-site": "same-origin" } },
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as { payload: typeof payload };
  expect(body.payload.ai.recorded).toEqual(recorded);
  expect((answer as unknown as { payload: typeof payload }).payload.ai.recorded).toEqual([LINK]);
});
