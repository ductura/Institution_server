// AI-RECORDED-5000: the database records up to 5000 transfers on a declaration
// (assistant.ai_transfer_max()), the declaration-v2 body carries up to 500. At
// 500 the v2 and v3 routes answer 200; above it the v2 routes answer the
// documented 503 unavailable without a server_error record, and the v3 routes
// answer 200 up to 5000. A list above 5000 is outside every contract: 503 with
// a record on the student routes, as any answer outside the contract. All
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
const BODY = {
  baseVersion: 0,
  revision: 1,
  form: { formId: "test-izjava", formVersion: 1, formSha256: "a".repeat(64) },
  ownWork: { confirmed: true },
  humanHelp: { received: false, entries: [] },
  ai: { use: "used", declaredTools: [], attachments: [], externalAttachmentIds: [] },
  confirm: true,
};

/** A payload that records `count` distinct transfers. */
function payloadWith(count: number) {
  const recorded = Array.from({ length: count }, (_, n) => ({
    aiTransferId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`,
    aiTransferSha256: "d".repeat(64),
  }));
  return { ...boundPayload, ai: { ...boundPayload.ai, recorded } };
}

function statementWith(count: number) {
  return {
    ...vectors("student.declaration.get.json").find((v) => v.name === "success")!.response.body,
    state: "confirmed",
    draft: null,
    payload: payloadWith(count),
    declarationSha256: bound.declarationSha256,
  };
}

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
  vi.restoreAllMocks();
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

/** The server_error records written while the request ran. */
function serverErrors(spy: { mock: { calls: unknown[][] } }) {
  return spy.mock.calls.filter((call) => String(call[0]).includes('"server_error"'));
}

it.each([
  ["v2 GET", "GET", "declaration-v2", 500, 200, false],
  ["v2 PUT", "PUT", "declaration-v2", 500, 200, false],
  ["v2 GET", "GET", "declaration-v2", 501, 503, false],
  ["v2 PUT", "PUT", "declaration-v2", 501, 503, false],
  ["v2 GET", "GET", "declaration-v2", 5000, 503, false],
  ["v3 GET", "GET", "declaration-v3", 500, 200, false],
  ["v3 PUT", "PUT", "declaration-v3", 500, 200, false],
  ["v3 GET", "GET", "declaration-v3", 501, 200, false],
  ["v3 PUT", "PUT", "declaration-v3", 501, 200, false],
  ["v3 GET", "GET", "declaration-v3", 5000, 200, false],
  ["v3 PUT", "PUT", "declaration-v3", 5000, 200, false],
  ["v3 GET", "GET", "declaration-v3", 5001, 503, true],
  ["v3 PUT", "PUT", "declaration-v3", 5001, 503, true],
] as const)(
  "student %s with %i recorded transfers answers %i",
  async (_name, method, path, count, status, recordsError) => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const answer = statementWith(count);
    const run = vi.fn<StatementPort["run"]>().mockResolvedValue({ status: "ok", body: answer });
    const base = await serve(
      createStatementRoutes({ institutionSlug: async () => "demo-fakultet", run }),
    );
    const response = await fetch(`${base}/student/assignments/${ASSIGNMENT}/${path}`, {
      method,
      headers: { ...HEADERS, ...(method === "PUT" ? { "content-type": "application/json" } : {}) },
      ...(method === "PUT" ? { body: JSON.stringify(BODY) } : {}),
    });
    expect(response.status).toBe(status);
    const body = (await response.json()) as {
      code?: string;
      payload?: { ai: { recorded: unknown[] } };
    };
    if (status === 200) expect(body.payload?.ai.recorded).toHaveLength(count);
    else expect(body.code).toBe("unavailable");
    // The documented 503 of a v2 route is not a server error; an answer outside every contract is.
    expect(serverErrors(errors)).toHaveLength(recordsError ? 1 : 0);
    // A v2 save above 500 is stored all the same: the port ran it.
    if (method === "PUT") expect(run).toHaveBeenCalledTimes(1);
  },
);

it.each([
  ["teacher.declaration-second.get", "declaration-v2", 500, 200],
  ["teacher.declaration-second.get", "declaration-v2", 501, 503],
  ["teacher.declaration-third.get", "declaration-v3", 500, 200],
  ["teacher.declaration-third.get", "declaration-v3", 501, 200],
  ["teacher.declaration-third.get", "declaration-v3", 5000, 200],
  ["teacher.declaration-third.get", "declaration-v3", 5001, 503],
] as const)("%s with %i recorded transfers answers %i", async (id, path, count, status) => {
  const answer = structuredClone({
    ...bound,
    payload: payloadWith(count),
  }) as unknown as TeacherDeclaration;
  const read = vi.fn<TeacherDeclarationReader>().mockResolvedValue({ status: "ok", body: answer });
  const base = await serve([createTeacherDeclarationRoute(read, id)]);
  const response = await fetch(
    `${base}/teacher/assignments/${ASSIGNMENT}/students/${STUDENT}/${path}`,
    { headers: { cookie: HEADERS.cookie, "sec-fetch-site": "same-origin" } },
  );
  expect(response.status).toBe(status);
  const body = (await response.json()) as {
    code?: string;
    payload?: { ai: { recorded: unknown[] } };
  };
  if (status === 200) expect(body.payload?.ai.recorded).toHaveLength(count);
  else expect(body.code).toBe("unavailable");
});
