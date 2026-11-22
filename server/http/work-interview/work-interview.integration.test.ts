import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createWorkInterviewRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const STUDENT = "s".repeat(43);
const TEACHER = "t".repeat(43);
const ID = "00000000-0000-4000-8000-000000000001";
const SLOT = "00000000-0000-4000-8000-0000000000b1";
const PATH = "/api/v1/works/doc-izmisljeni/interview";
const AT = "2026-12-04T12:00:00.000Z";
const CREATED = "2026-11-24T09:00:00.000Z";
const query = vi.fn<(token: string, sql: string, values?: readonly unknown[]) => unknown[]>();
const withActor: WithActor = (token, run) =>
  run({
    query: async (sql, values) => {
      const rows = sql.includes("identity.touch_current_session")
        ? [{ touched: false }]
        : query(token!, sql, values);
      return { rows, rowCount: rows.length };
    },
  } as ActorTransaction);

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createWorkInterviewRoutesFor({ withActor }),
  });
});
afterAll(async () => server.close());
beforeEach(() => {
  query.mockReset();
});

function call(method: string, path: string, token?: string, body?: string, origin = ORIGIN) {
  const headers = new Headers({ origin });
  if (token !== undefined) headers.set("cookie", `__Host-ductus_session=${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return fetch(`http://127.0.0.1:${server.port}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body }),
  });
}

// The database writes timestamps into JSON with an offset; the adapter answers them in UTC.
const dbQuestion = {
  id: ID,
  paragraphRef: "odlomak-1",
  questionText: "Kako je nastao ovaj odlomak?",
  createdAt: "2026-11-24T10:00:00.000000+01:00",
  mine: true,
};
const apiQuestion = { ...dbQuestion, createdAt: CREATED };
const dbInterview = {
  invitedAt: "2026-11-24T10:00:00.5+01:00",
  questions: [dbQuestion],
  explanations: [],
  appointment: { place: "Ured 12", at: "2026-12-04T13:00:00+01:00" },
  heldOn: null,
};
const apiInterview = {
  invitedAt: "2026-11-24T09:00:00.500Z",
  questions: [apiQuestion],
  explanations: [],
  appointment: { place: "Ured 12", at: AT },
  heldOn: null,
};

describe("work interview preparation", () => {
  it("reads the preparation and answers its times in UTC", async () => {
    query.mockReturnValueOnce([{ result: dbInterview }]);
    const response = await call("GET", PATH, TEACHER);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(apiInterview);
    expect(query).toHaveBeenCalledWith(
      TEACHER,
      expect.stringContaining("institution.work_interview_get($1)"),
      ["doc-izmisljeni"],
    );
  });

  it("adds a question and removes it", async () => {
    query.mockReturnValueOnce([{ result: dbQuestion }]).mockReturnValueOnce([{ result: null }]);
    const created = await call(
      "POST",
      `${PATH}/questions`,
      TEACHER,
      JSON.stringify({ paragraphRef: "odlomak-1", questionText: dbQuestion.questionText }),
    );
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(await created.json()).toEqual(apiQuestion);
    expect(query).toHaveBeenNthCalledWith(
      1,
      TEACHER,
      expect.stringContaining("institution.add_work_interview_question($1, $2, $3)"),
      ["doc-izmisljeni", "odlomak-1", dbQuestion.questionText],
    );

    const removed = await call("DELETE", `${PATH}/questions/${ID}`, TEACHER);
    expect(removed.status).toBe(204);
    expect(await removed.text()).toBe("");
    expect(query).toHaveBeenNthCalledWith(
      2,
      TEACHER,
      expect.stringContaining("institution.remove_work_interview_question($1, $2::uuid)"),
      ["doc-izmisljeni", ID],
    );
  });

  it("passes a general question as no paragraph", async () => {
    query.mockReturnValueOnce([{ result: { ...dbQuestion, paragraphRef: null } }]);
    await call("POST", `${PATH}/questions`, TEACHER, '{"questionText":"Što bi promijenio/la?"}');
    expect(query).toHaveBeenCalledWith(TEACHER, expect.any(String), [
      "doc-izmisljeni",
      null,
      "Što bi promijenio/la?",
    ]);
  });

  it("invites, sets the appointment, marks held and takes an explanation", async () => {
    query
      .mockReturnValueOnce([{ result: dbInterview }])
      .mockReturnValueOnce([{ result: dbInterview }])
      .mockReturnValueOnce([{ result: dbInterview }])
      .mockReturnValueOnce([{ result: dbInterview }])
      .mockReturnValueOnce([
        { result: { id: ID, questionId: ID, text: "Objašnjenje.", createdAt: CREATED } },
      ]);
    expect((await call("POST", `${PATH}/invite`, TEACHER)).status).toBe(200);
    const free = await call(
      "PUT",
      `${PATH}/appointment`,
      TEACHER,
      JSON.stringify({ place: "Ured 12", at: AT }),
    );
    expect(free.status).toBe(200);
    expect(query).toHaveBeenNthCalledWith(
      2,
      TEACHER,
      expect.stringContaining("set_work_interview_appointment"),
      ["doc-izmisljeni", null, "Ured 12", AT],
    );
    const slot = await call(
      "PUT",
      `${PATH}/appointment`,
      STUDENT,
      JSON.stringify({ consultationSlotId: SLOT }),
    );
    expect(slot.status).toBe(200);
    expect(query).toHaveBeenNthCalledWith(3, STUDENT, expect.any(String), [
      "doc-izmisljeni",
      SLOT,
      null,
      null,
    ]);
    const held = await call("POST", `${PATH}/held`, TEACHER, '{"date":"2026-11-25"}');
    expect(held.status).toBe(200);
    expect(query).toHaveBeenNthCalledWith(4, TEACHER, expect.any(String), [
      "doc-izmisljeni",
      "2026-11-25",
    ]);
    const explained = await call(
      "POST",
      `${PATH}/explanations`,
      STUDENT,
      JSON.stringify({ questionId: ID, text: "Objašnjenje." }),
    );
    expect(explained.status).toBe(201);
    expect(await explained.json()).toEqual({
      id: ID,
      questionId: ID,
      text: "Objašnjenje.",
      createdAt: CREATED,
    });
  });

  it.each([
    ["POST", `${PATH}/invite`, undefined, undefined, 401],
    ["GET", PATH.replace("doc-izmisljeni", "%00"), STUDENT, undefined, 404],
    ["DELETE", `${PATH}/questions/neispravan-id`, TEACHER, undefined, 404],
    ["POST", `${PATH}/questions`, TEACHER, "{", 400],
    ["POST", `${PATH}/questions`, TEACHER, '{"questionText":""}', 422],
    ["POST", `${PATH}/questions`, TEACHER, '{"questionText":"?","outcome":"x"}', 422],
    ["POST", `${PATH}/held`, TEACHER, '{"date":"25.11."}', 422],
    ["POST", `${PATH}/held`, TEACHER, '{"date":"2026-11-25","outcome":"x"}', 422],
    ["PUT", `${PATH}/appointment`, TEACHER, '{"place":"Ured"}', 422],
    ["PUT", `${PATH}/appointment`, TEACHER, `{"consultationSlotId":"${SLOT}","place":"Ured"}`, 422],
    ["POST", `${PATH}/explanations`, STUDENT, '{"text":""}', 422],
    ["POST", `${PATH}/explanations`, STUDENT, '{"text":"x","grade":5}', 422],
  ] as const)(
    "refuses an invalid %s %s before querying the database",
    async (method, path, token, body, status) => {
      expect((await call(method, path, token, body)).status).toBe(status);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("refuses a cross-origin mutation before querying the database", async () => {
    const response = await call(
      "POST",
      `${PATH}/invite`,
      TEACHER,
      undefined,
      "https://druga.invalid",
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "origin_mismatch" });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    ["GET", PATH, "ZD403", 403, "forbidden"],
    ["POST", `${PATH}/invite`, "ZD409", 409, "conflict"],
    ["POST", `${PATH}/held`, "22008", 422, "invalid_input"],
  ] as const)("uses the database refusal for %s %s", async (method, path, dbCode, status, code) => {
    query.mockImplementationOnce(() => {
      throw Object.assign(new Error("test refusal"), { code: dbCode });
    });
    const response = await call(
      method,
      path,
      TEACHER,
      method === "GET" || path.endsWith("invite") ? undefined : '{"date":"2026-02-30"}',
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });
});
