// The questionnaire routes of a student and of a teacher (SRV-V18-UPITNIK-
// ISPUNJAVANJE) on a real server with the real pipeline, over a fake store: a
// body outside the contract and a malformed id never reach the store, the
// database's refusals read as 401, 404, 409 and 422, nothing sent carries a
// person next to the answers, and an answer outside the contract is 503.
// All values are invented.
import { afterEach, describe, expect, it } from "vitest";

import { createDatabases, createLayers, type Running, startServer } from "./index.ts";
import {
  createQuestionnaireResponsesRoutes,
  type QuestionnaireResponsesPort,
} from "./questionnaire-responses.ts";

const ORIGIN = "https://ductura.example.invalid";
const ID = "00000000-0000-4000-8000-0000000000b1";
const Q1 = "00000000-0000-4000-8000-0000000000f1";
const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ANSWERS = { answers: [{ questionId: Q1, value: "da" }] };

let running: Running | undefined;
const calls: unknown[][] = [];
let reply: () => Promise<unknown> = async () => undefined;
const refusal = (code: string) => Object.assign(new Error("refused"), { code });

async function start(): Promise<string> {
  const record =
    (name: string) =>
    (...args: unknown[]) => (calls.push([name, ...args]), reply());
  const port = {
    listForStudent: record("listForStudent"),
    readForStudent: record("readForStudent"),
    submit: record("submit"),
    enterByHand: record("enterByHand"),
  } as unknown as QuestionnaireResponsesPort;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createQuestionnaireResponsesRoutes(port),
  });
  return `http://127.0.0.1:${running.port}/api/v1`;
}

afterEach(async () => {
  calls.length = 0;
  reply = async () => undefined;
  await running?.close();
  running = undefined;
});

const get = (base: string, path: string, cookie: string | null = COOKIE) =>
  fetch(`${base}${path}`, {
    headers: { "sec-fetch-site": "same-origin", ...(cookie === null ? {} : { cookie }) },
  });
const post = (base: string, path: string, body: string, cookie: string | null = COOKIE) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: {
      ...(cookie === null ? {} : { cookie }),
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
    },
    body,
  });

const FORM = {
  id: ID,
  courseId: "00000000-0000-4000-8000-0000000000c1",
  title: "Izmišljeno istraživanje",
  state: "open",
  participated: false,
  questions: [
    {
      id: Q1,
      order: 1,
      kind: "single",
      text: "Kompostirate li?",
      options: [
        { code: "da", label: "Da" },
        { code: "ne", label: "Ne" },
      ],
      scale: null,
    },
  ],
};

describe("student questionnaires", () => {
  it("lists the open questionnaires", async () => {
    const base = await start();
    reply = async () => [
      { id: ID, courseId: FORM.courseId, title: FORM.title, participated: true },
    ];
    const response = await get(base, "/student/questionnaires");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      questionnaires: [{ id: ID, courseId: FORM.courseId, title: FORM.title, participated: true }],
    });
    expect(calls).toEqual([["listForStudent", TOKEN]]);
  });

  it("reads a form without the state, in lower case id", async () => {
    const base = await start();
    reply = async () => FORM;
    const response = await get(base, `/student/questionnaires/${ID.toUpperCase()}`);
    expect(response.status).toBe(200);
    const json = (await response.json()) as Record<string, unknown>;
    expect(json["state"]).toBeUndefined();
    expect(json["id"]).toBe(ID);
    expect(calls).toEqual([["readForStudent", TOKEN, ID]]);
  });

  it("a malformed id is 404 and reaches no store", async () => {
    const base = await start();
    expect((await get(base, "/student/questionnaires/nije-uuid")).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("no session is 401 and reaches no store", async () => {
    const base = await start();
    expect((await get(base, "/student/questionnaires", null)).status).toBe(401);
    expect((await get(base, `/student/questionnaires/${ID}`, null)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("a refusal of the database is 404 for another's or a not open questionnaire", async () => {
    const base = await start();
    reply = async () => Promise.reject(refusal("ZD404"));
    expect((await get(base, `/student/questionnaires/${ID}`)).status).toBe(404);
  });

  it("an answer outside the contract is 503, not a leak", async () => {
    const base = await start();
    reply = async () => ({ ...FORM, courseId: "nije-uuid" });
    expect((await get(base, `/student/questionnaires/${ID}`)).status).toBe(503);
  });
});

describe.each([
  ["student", `/student/questionnaires/${ID}/responses`, "submit"],
  ["teacher", `/teacher/questionnaires/${ID}/responses/manual`, "enterByHand"],
])("%s answers", (_who, path, method) => {
  it("stores exactly the answers, 204, and sends no person", async () => {
    const base = await start();
    const response = await post(base, path, JSON.stringify(ANSWERS));
    expect(response.status).toBe(204);
    expect(calls).toEqual([[method, TOKEN, ID, ANSWERS.answers]]);
  });

  it.each([
    ['{"answers":[]}', 422],
    ['{"answers":"da"}', 422],
    [`{"answers":[{"questionId":"x","value":"da"}]}`, 422],
    [`{"answers":[{"questionId":"${Q1}","value":{}}]}`, 422],
    [`{"answers":[{"questionId":"${Q1}","value":"da","person":"x"}]}`, 422],
    [`{"answers":[{"questionId":"${Q1}","value":"da"}],"userId":"x"}`, 422],
    ['{"answers":', 400],
  ])("a body %s is %i and reaches no store", async (body, status) => {
    const base = await start();
    expect((await post(base, path, body)).status).toBe(status);
    expect(calls).toEqual([]);
  });

  it("a malformed id is 404 and reaches no store", async () => {
    const base = await start();
    const bad = path.replace(ID, "nije-uuid");
    expect((await post(base, bad, JSON.stringify(ANSWERS))).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("no session is 401 and reaches no store", async () => {
    const base = await start();
    expect((await post(base, path, JSON.stringify(ANSWERS), null)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it.each([
    ["ZD401", 401],
    ["ZD404", 404],
    ["ZD409", 409],
    ["ZD422", 422],
  ])("the database's %s is %i", async (code, status) => {
    const base = await start();
    reply = async () => Promise.reject(refusal(code));
    expect((await post(base, path, JSON.stringify(ANSWERS))).status).toBe(status);
  });

  it("another failure is 503", async () => {
    const base = await start();
    reply = async () => Promise.reject(new Error("boom"));
    expect((await post(base, path, JSON.stringify(ANSWERS))).status).toBe(503);
  });
});
