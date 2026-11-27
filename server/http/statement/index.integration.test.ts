import { afterEach, expect, it, vi } from "vitest";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";
import { createStatementRoutes, type StatementPort } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const HEADERS = {
  cookie: `__Host-ductus_session=${"V".repeat(43)}`,
  origin: ORIGIN,
  "sec-fetch-site": "same-origin",
};
const ID = "00000000-0000-4000-8000-0000000000a1";
const BODY = {
  baseVersion: 0,
  revision: 1,
  form: { formId: "test-izjava", formVersion: 1, formSha256: "a".repeat(64) },
  ownWork: { confirmed: true },
  humanHelp: {
    received: true,
    entries: [{ kind: "language", text: "Izmišljena kolegica pregledala je uvod." }],
  },
  ai: { use: "used", declaredTools: [], attachments: [], externalAttachmentIds: [] },
  confirm: true,
};
let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

async function serve(answer: Awaited<ReturnType<StatementPort["run"]>>) {
  const run = vi.fn<StatementPort["run"]>().mockResolvedValue(answer);
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createStatementRoutes({ institutionSlug: async () => "demo-fakultet", run }),
  });
  return { url: `http://127.0.0.1:${running.port}/api/v1/student/assignments/${ID}`, run };
}

it.each([
  ["text/html", "<p>Izmisljeni ispis</p>", 415],
  ["application/json", '{"izmisljeno":true}', 415],
  ["image/png", "izmisljeno", 415],
  ["application/pdf", "nije PDF", 422],
  ["text/plain", "", 422],
])(
  "refuses %s with an unsupported type or invalid bytes without a DB write",
  async (type, body, status) => {
    const { url, run } = await serve({ status: "conflict" });
    const response = await fetch(`${url}/declaration-attachments`, {
      method: "POST",
      headers: { ...HEADERS, "content-type": type },
      body,
    });
    expect(response.status).toBe(status);
    expect(run).not.toHaveBeenCalled();
  },
);

it.each([
  ["text/plain; charset=utf-8", "Izmišljeni ispis."],
  ["application/pdf", "%PDF-1.4\n% synthetic fixture"],
])("stores %s as the exact original bytes", async (type, body) => {
  const format = type.split(";")[0];
  const bytes = new TextEncoder().encode(body);
  const upload = {
    externalAttachmentId: ID,
    format,
    byteLength: bytes.length,
    contentSha256: "b".repeat(64),
  };
  const { url, run } = await serve({ status: "ok", body: upload });
  const response = await fetch(`${url}/declaration-attachments`, {
    method: "POST",
    headers: { ...HEADERS, "content-type": type },
    body,
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual(upload);
  expect(run).toHaveBeenCalledWith("V".repeat(43), ID, "demo-fakultet", {
    type: "upload",
    format,
    bytes,
  });
});

it.each([
  [{ ...BODY, principalId: ID }, 422],
  [
    {
      ...BODY,
      humanHelp: { received: true, entries: [{ kind: "unlisted", text: "Izmišljeni unos." }] },
    },
    422,
  ],
  [{ ...BODY, ownWork: { confirmed: false } }, 409, "incomplete"],
])(
  "refuses invalid or incomplete declarations before the DB write",
  async (body, status, code = "invalid_input") => {
    const { url, run } = await serve({ status: "conflict" });
    const response = await fetch(`${url}/declaration`, {
      method: "PUT",
      headers: { ...HEADERS, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
    expect(run).not.toHaveBeenCalled();
  },
);

async function save(answer: Awaited<ReturnType<StatementPort["run"]>>) {
  const { url } = await serve(answer);
  return fetch(`${url}/declaration`, {
    method: "PUT",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify(BODY),
  });
}

it.each([
  [
    { status: "conflict", reason: "declaration_conflict", currentVersion: 3 },
    409,
    { currentVersion: 3 },
  ],
  [
    { status: "conflict", reason: "stale_revision", currentRevision: 2 },
    409,
    { currentRevision: 2 },
  ],
  [
    { status: "conflict", reason: "attachment_stale", conversationIds: [ID] },
    409,
    { conversationIds: [ID] },
  ],
  [
    { status: "conflict", reason: "mandatory_attachment_missing", conversationIds: [ID] },
    409,
    { conversationIds: [ID] },
  ],
  [{ status: "conflict", reason: "already_submitted" }, 409, {}],
  [{ status: "conflict", reason: "form_outdated" }, 409, {}],
  [{ status: "conflict", reason: "incomplete" }, 409, {}],
  [{ status: "not_found", reason: "invalid_attachment" }, 422, {}],
  [{ status: "invalid_input", reason: "invalid_attachment" }, 422, {}],
] as const)(
  "answers the RPC reason %o with its own code and context",
  async (answer, status, context) => {
    const response = await save(answer);
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body).toEqual({
      ...context,
      error: answer.reason,
      code: answer.reason,
      messageKey: expect.stringMatching(/^errors\./u),
      status,
      requestId: expect.any(String),
    });
  },
);

it.each([
  [{ status: "conflict" }, 409, "conflict"],
  [{ status: "conflict", reason: "unlisted_reason" }, 409, "conflict"],
  [{ status: "not_found", reason: "unlisted_reason" }, 404, "not_found"],
] as const)(
  "answers %o without a listed reason with the shared code",
  async (answer, status, code) => {
    const response = await save(answer);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  },
);

it("answers 500 when the RPC context does not fit the contract of its reason", async () => {
  const response = await save({
    status: "conflict",
    reason: "already_submitted",
    currentVersion: 3,
  });
  expect(response.status).toBe(500);
  expect(JSON.stringify(await response.json())).not.toContain("currentVersion");
});

it.each(["too_many_attachments", "attachments_too_large", "already_submitted"])(
  "answers the upload refusal %s with its own code",
  async (reason) => {
    const { url } = await serve({ status: "conflict", reason });
    const response = await fetch(`${url}/declaration-attachments`, {
      method: "POST",
      headers: { ...HEADERS, "content-type": "text/plain" },
      body: "Izmišljeni ispis.",
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: reason });
  },
);

// SRV-IZJAVA-PITANJE: the optional answer travels beside the closed
// declaration-v1 body; the port gets both apart, and a bad answer is refused
// before the database.
const QID = "00000000-0000-4000-8000-0000000000e1";
async function saveWith(body: unknown) {
  const { url, run } = await serve({ status: "conflict", reason: "form_outdated" });
  const response = await fetch(`${url}/declaration`, {
    method: "PUT",
    headers: { ...HEADERS, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { response, run };
}

it("passes the answer to the port beside the declaration body", async () => {
  const answer = { questionId: QID, text: "Izmišljeni odgovor." };
  const { response, run } = await saveWith({ ...BODY, questionAnswer: answer });
  expect(response.status).toBe(409);
  expect(run).toHaveBeenCalledWith(expect.any(String), ID, "demo-fakultet", {
    type: "save",
    body: BODY,
    answer,
    explanation: null,
  });
});

it.each([
  ["omitted", BODY],
  ["null", { ...BODY, questionAnswer: null }],
])("an answer %s is no answer", async (_name, body) => {
  const { run } = await saveWith(body);
  expect(run).toHaveBeenCalledWith(expect.any(String), ID, "demo-fakultet", {
    type: "save",
    body: BODY,
    answer: null,
    explanation: null,
  });
});

it.each([
  ["a string", "odgovor"],
  ["an unknown key", { questionId: QID, text: "odgovor", extra: 1 }],
  ["an empty text", { questionId: QID, text: "" }],
  ["2001 code points", { questionId: QID, text: "ž".repeat(2001) }],
  ["an id that is no uuid", { questionId: "pitanje", text: "odgovor" }],
])("refuses an answer with %s before the database", async (_name, questionAnswer) => {
  const { response, run } = await saveWith({ ...BODY, questionAnswer });
  expect(response.status).toBe(422);
  expect(run).not.toHaveBeenCalled();
});

// SRV-F4-EDI-R07: the student's own conversations a declaration can attach.
const CONVERSATION = {
  conversationId: "00000000-0000-4000-8000-0000000000d1",
  reason: "student_added",
  throughSeq: 2,
  messagesSha256: "c".repeat(64),
};

it("lists the conversations of the owner with the reference values and no cookie-less read", async () => {
  const { url, run } = await serve({ status: "ok", body: { conversations: [CONVERSATION] } });
  const response = await fetch(`${url}/declaration-conversations`, { headers: HEADERS });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ conversations: [CONVERSATION] });
  expect(run).toHaveBeenCalledWith(expect.any(String), ID, "demo-fakultet", {
    type: "conversations",
  });
  const anonymous = await fetch(`${url}/declaration-conversations`, {
    headers: { origin: ORIGIN, "sec-fetch-site": "same-origin" },
  });
  expect(anonymous.status).toBe(401);
  expect(run).toHaveBeenCalledTimes(1);
});

it("answers 404 for another student's or a missing assignment, and for a malformed id", async () => {
  const { url, run } = await serve({ status: "not_found" });
  const refused = await fetch(`${url}/declaration-conversations`, { headers: HEADERS });
  expect(refused.status).toBe(404);
  const bad = await fetch(url.replace(ID, "not-an-id") + "/declaration-conversations", {
    headers: HEADERS,
  });
  expect(bad.status).toBe(404);
  expect(run).toHaveBeenCalledTimes(1);
});

it("refuses a cross-site read and a response outside the contract", async () => {
  const { url, run } = await serve({
    status: "ok",
    body: { conversations: [{ conversationId: 1 }] },
  });
  const cross = await fetch(`${url}/declaration-conversations`, {
    headers: { ...HEADERS, "sec-fetch-site": "cross-site" },
  });
  expect(cross.status).toBe(403);
  expect(run).not.toHaveBeenCalled();
  const invalid = await fetch(`${url}/declaration-conversations`, { headers: HEADERS });
  expect(invalid.status).toBe(503);
});
