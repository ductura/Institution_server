// F4-PRE-R02-SRV2 (R-35, declaration-v1 section 6.9): the optional
// explanation of a pattern of use the record of transfers contradicts travels
// beside the closed declaration body on the v2 and v3 PUT. The port gets it
// apart, a bad one is refused before the database, and the v1 PUT does not
// know the key. All values are invented.
import { readFileSync } from "node:fs";

import { afterEach, expect, it, vi } from "vitest";

import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createStatementRoutes, type StatementPort } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const HEADERS = {
  cookie: `__Host-ductus_session=${"V".repeat(43)}`,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
  "content-type": "application/json",
};
const ID = "00000000-0000-4000-8000-0000000000a1";
const BODY = {
  baseVersion: 0,
  revision: 1,
  form: { formId: "test-izjava", formVersion: 1, formSha256: "a".repeat(64) },
  ownWork: { confirmed: true },
  humanHelp: { received: false, entries: [] },
  ai: { use: "not_used", declaredTools: [], attachments: [], externalAttachmentIds: [] },
  confirm: false,
};
const EXPLANATION = "Izmišljeno objašnjenje:\nprijenos je bio probni i nije ušao u rad.";
const SUCCESS = (
  JSON.parse(
    readFileSync(
      new URL("../../contracts/vectors/student.declaration.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: { name: string; response: { body: Record<string, unknown> } }[] }
).vectors.find((v) => v.name === "success")!.response.body;

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function save(
  path: string,
  body: unknown,
  answer?: Awaited<ReturnType<StatementPort["run"]>>,
) {
  const run = vi
    .fn<StatementPort["run"]>()
    .mockResolvedValue(answer ?? { status: "conflict", reason: "form_outdated" });
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createStatementRoutes({ institutionSlug: async () => "demo-fakultet", run }),
  });
  const response = await fetch(
    `http://127.0.0.1:${running.port}/api/v1/student/assignments/${ID}/${path}`,
    { method: "PUT", headers: HEADERS, body: JSON.stringify(body) },
  );
  return { response, run };
}

it.each(["declaration-v2", "declaration-v3"])(
  "%s passes the explanation to the port and answers it back",
  async (path) => {
    const { response, run } = await save(
      path,
      { ...BODY, mismatchExplanation: EXPLANATION },
      { status: "ok", body: { ...SUCCESS, mismatchExplanation: EXPLANATION } },
    );
    expect(response.status).toBe(200);
    expect(((await response.json()) as { mismatchExplanation?: unknown }).mismatchExplanation).toBe(
      EXPLANATION,
    );
    expect(run).toHaveBeenCalledWith(expect.any(String), ID, "demo-fakultet", {
      type: "save",
      body: BODY,
      answer: null,
      explanation: EXPLANATION,
    });
  },
);

it.each([
  ["omitted", "declaration-v2", BODY],
  ["null", "declaration-v2", { ...BODY, mismatchExplanation: null }],
  ["null", "declaration-v3", { ...BODY, mismatchExplanation: null }],
])("an explanation %s on %s is no explanation", async (_name, path, body) => {
  const { run } = await save(path, body);
  expect(run).toHaveBeenCalledWith(expect.any(String), ID, "demo-fakultet", {
    type: "save",
    body: BODY,
    answer: null,
    explanation: null,
  });
});

it.each([
  ["an empty text", ""],
  ["2001 code points", "ž".repeat(2001)],
  ["a leading space", " objašnjenje"],
  ["a control character", "objašnjenje\u0007"],
  ["a number", 7],
  ["an object", { text: "objašnjenje" }],
])("refuses an explanation with %s before the database", async (_name, mismatchExplanation) => {
  for (const path of ["declaration-v2", "declaration-v3"]) {
    const { response, run } = await save(path, { ...BODY, mismatchExplanation });
    expect(response.status).toBe(422);
    expect(run).not.toHaveBeenCalled();
    await running?.close();
    running = undefined;
  }
});

it("the v1 PUT does not know the explanation: 422 before the database", async () => {
  const { response, run } = await save("declaration", {
    ...BODY,
    mismatchExplanation: EXPLANATION,
  });
  expect(response.status).toBe(422);
  expect(run).not.toHaveBeenCalled();
});
