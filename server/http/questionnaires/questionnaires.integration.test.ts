// SRV-V18-UPITNIK-AUTOR: the five questionnaire routes on a real server and pipeline, over a fake
// withActor that answers like the database (the SQL itself is db/main/tests/247-questionnaire.sql):
// a teacher of the course makes, reads, changes a draft, opens and closes; a student, a stranger,
// an unknown and a malformed id are the same 404; a step the state forbids is 409; input the route
// refuses never reaches the database. All values are invented.
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createQuestionnaireRoutesFor } from "./index.ts";

const COURSE = "00000000-0000-4000-8000-0000000c1801";
const OTHER_COURSE = "00000000-0000-4000-8000-0000000c1802";
const ORIGIN = "https://ductura.example.invalid";
const TEACHER = "izmisljeni-token-nastavnika-000000000000001";
const STUDENT = "izmisljeni-token-studenta-00000000000000001";
const SIGNED_OUT = "izmisljeni-token-odjavljen-0000000000000000";
const BROKEN = "izmisljeni-token-pokvaren-00000000000000000";
const refuse = (code: string) => Object.assign(new Error(code), { code });

type Question = {
  kind: string;
  text: string;
  options?: { code: string; label: string }[];
  scale?: { min: number; max: number };
};
type Stored = { id: string; courseId: string; title: string; state: string; questions: Question[] };
const stored = new Map<string, Stored>();
let writes = 0;
let touches = 0;
let next = 1;
const ID = (n: number) => `00000000-0000-4000-8000-0000000b18${String(n).padStart(2, "0")}`;

const form = (q: Stored) =>
  q.questions.map((question, index) => ({
    questionnaireId: q.id,
    courseId: q.courseId,
    title: q.title,
    state: q.state,
    questionId: `00000000-0000-4000-8000-0000000d18${String(index + 1).padStart(2, "0")}`,
    ord: index + 1,
    kind: question.kind,
    body: question.text,
    options: question.options ?? null,
    scale: question.scale ?? null,
  }));

const withActor = (async (token: string, fn: (tx: unknown) => Promise<unknown>) => {
  if (token === SIGNED_OUT) throw refuse("ZD401");
  if (token === BROKEN) throw new Error("down");
  const teacher = token === TEACHER;
  return fn({
    async query(sql: string, params: unknown[] = []) {
      const id = params[0] as string;
      const mine = (): Stored => {
        const found = stored.get(id);
        if (!teacher || found === undefined) throw refuse("ZD404");
        return found;
      };
      if (sql.includes("app.create_questionnaire")) {
        writes += 1;
        if (!teacher || id !== COURSE) throw refuse("ZD404");
        const made = {
          id: ID(next++),
          courseId: id,
          title: params[1] as string,
          state: "draft",
          questions: JSON.parse(params[2] as string) as Question[],
        };
        stored.set(made.id, made);
        return { rows: [{ id: made.id }] };
      }
      if (sql.includes("app.update_questionnaire")) {
        writes += 1;
        const found = mine();
        if (found.state !== "draft") throw refuse("ZD409");
        found.title = params[1] as string;
        found.questions = JSON.parse(params[2] as string) as Question[];
        return { rows: [{ id }] };
      }
      if (sql.includes("app.set_questionnaire_state")) {
        writes += 1;
        const found = mine();
        const to = params[1] as string;
        if (!(
          (found.state === "draft" && to === "open") ||
          (found.state === "open" && to === "closed")
        )) {
          throw refuse("ZD409");
        }
        found.state = to;
        return { rows: [{ state: to }] };
      }
      if (sql.includes("app.teacher_questionnaires")) {
        if (!teacher || id !== COURSE) throw refuse("ZD404");
        const rows = [...stored.values()]
          .filter((q) => q.courseId === id)
          .map((q) => ({
            id: q.id,
            title: q.title,
            state: q.state,
            createdOn: "2026-11-02",
            questionCount: q.questions.length,
            responseCount: 0,
          }));
        return { rows };
      }
      if (sql.includes("app.teacher_questionnaire(")) return { rows: form(mine()) };
      if (sql.includes("touch_current_session")) {
        touches += 1;
        return { rows: [{ touched: true }] };
      }
      throw new Error(`unexpected sql ${sql}`);
    },
  });
}) as never;

let server: Running | undefined;
afterEach(async () => {
  await server?.close();
  server = undefined;
  stored.clear();
  writes = 0;
  touches = 0;
  next = 1;
});

async function call(
  method: "GET" | "POST" | "PATCH",
  path: string,
  token?: string,
  body?: string,
  type = "application/json",
) {
  server ??= await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: createQuestionnaireRoutesFor({ withActor }),
  });
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers.cookie = `__Host-ductus_session=${token}`;
    if (method !== "GET") {
      Object.assign(headers, {
        origin: ORIGIN,
        "sec-fetch-site": "same-origin",
        "content-type": type,
      });
    }
    const req = httpRequest(
      { host: "127.0.0.1", port: server!.port, path, method, headers },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => (text += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(text) }));
      },
    );
    req.on("error", reject);
    req.end(body);
  });
}

const courseUrl = (id = COURSE) => `/api/v1/teacher/courses/${id}/questionnaires`;
const oneUrl = (id: string) => `/api/v1/teacher/questionnaires/${id}`;
const QUESTIONS: Question[] = [
  {
    kind: "single",
    text: "Kompostirate li kod kuće?",
    options: [
      { code: "da", label: "Da" },
      { code: "ne", label: "Ne" },
    ],
  },
  { kind: "scale", text: "Koliko vam je to važno?", scale: { min: 1, max: 5 } },
  { kind: "text", text: "Što vas sprječava?" },
];
const send = (title: string, questions: unknown) => JSON.stringify({ title, questions });
const make = (token: string | undefined = TEACHER, questions: unknown = QUESTIONS) =>
  call("POST", courseUrl(), token, send("Izmišljeni upitnik", questions));

describe("questionnaire routes", () => {
  it("makes a draft and answers it with the ids of its questions in order", async () => {
    const made = await make();
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({
      courseId: COURSE,
      title: "Izmišljeni upitnik",
      state: "draft",
    });
    const questions = made.body.questions as {
      order: number;
      kind: string;
      options: unknown;
      scale: unknown;
    }[];
    expect(questions.map((q) => [q.order, q.kind])).toEqual([
      [1, "single"],
      [2, "scale"],
      [3, "text"],
    ]);
    expect(questions[2]).toMatchObject({ options: null, scale: null });
    expect(questions[1]?.scale).toEqual({ min: 1, max: 5 });
    expect(await call("GET", oneUrl(made.body.id as string), TEACHER)).toEqual({
      status: 200,
      body: made.body,
    });
  });

  it("lists the questionnaires of a course as numbers, with no person", async () => {
    await make();
    const list = await call("GET", courseUrl(), TEACHER);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({
      questionnaires: [
        {
          id: ID(1),
          title: "Izmišljeni upitnik",
          state: "draft",
          createdOn: "2026-11-02",
          questionCount: 3,
          responseCount: 0,
        },
      ],
    });
  });

  it("changes a draft, and refuses to change an open or a closed one with 409", async () => {
    const id = (await make()).body.id as string;
    const changed = await call("PATCH", oneUrl(id), TEACHER, send("Novi naslov", [QUESTIONS[2]]));
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ title: "Novi naslov", state: "draft" });
    expect((changed.body.questions as unknown[]).length).toBe(1);
    const opened = await call("POST", `${oneUrl(id)}/state`, TEACHER, '{"state":"open"}');
    expect(opened).toEqual({ status: 200, body: { id, state: "open" } });
    const refused = await call("PATCH", oneUrl(id), TEACHER, send("Treći naslov", QUESTIONS));
    expect(refused.status).toBe(409);
    expect(stored.get(id)?.title).toBe("Novi naslov");
  });

  it("moves the state one way only: open, then closed, never back or twice", async () => {
    const id = (await make()).body.id as string;
    const state = (to: string) =>
      call("POST", `${oneUrl(id)}/state`, TEACHER, JSON.stringify({ state: to }));
    expect((await state("closed")).status).toBe(409);
    expect((await state("open")).status).toBe(200);
    expect((await state("open")).status).toBe(409);
    expect((await state("closed")).status).toBe(200);
    expect((await state("open")).status).toBe(409);
    expect(stored.get(id)?.state).toBe("closed");
    expect((await state("draft")).status).toBe(422);
  });

  it("answers a student, a teacher of another course, an unknown and a malformed id with the same 404", async () => {
    const id = (await make()).body.id as string;
    const four = [
      await call("GET", oneUrl(id), STUDENT),
      await call("GET", oneUrl(ID(99)), TEACHER),
      await call("GET", oneUrl("not-an-id"), TEACHER),
      await call("PATCH", oneUrl(id), STUDENT, send("Tuđe", QUESTIONS)),
      await call("POST", `${oneUrl(id)}/state`, STUDENT, '{"state":"open"}'),
      await call("GET", courseUrl(OTHER_COURSE), TEACHER),
      await make(STUDENT),
    ];
    for (const refused of four) {
      expect(refused.status).toBe(404);
      expect(refused.body).toMatchObject({ code: "not_found" });
    }
    expect(stored.get(id)).toMatchObject({ title: "Izmišljeni upitnik", state: "draft" });
  });

  it("refuses input outside the rules before the database is asked", async () => {
    const before = writes;
    const bad: unknown[] = [
      [],
      [{ kind: "single", text: "Jedna opcija?", options: [{ code: "da", label: "Da" }] }],
      [{ kind: "scale", text: "Skala?", scale: { min: 5, max: 1 } }],
      [
        {
          kind: "text",
          text: "Tekst?",
          options: [
            { code: "a", label: "A" },
            { code: "b", label: "B" },
          ],
        },
      ],
      [{ kind: "scale", text: "Skala?", scale: null }],
      [{ kind: "text", text: " razmak " }],
      [{ kind: "sum", text: "Zbroj?" }],
      [{ kind: "text", text: "Nul\u0000znak" }],
    ];
    for (const questions of bad) {
      const refused = await make(TEACHER, questions);
      expect(refused.status, JSON.stringify(questions)).toBe(422);
      expect(refused.body).toMatchObject({ code: "invalid_input" });
    }
    expect((await call("POST", courseUrl(), TEACHER, send("", QUESTIONS))).status).toBe(422);
    expect(
      (await call("POST", courseUrl(), TEACHER, '{"title":"x","questions":[],"authorId":"x"}'))
        .status,
    ).toBe(422);
    expect((await call("POST", courseUrl(), TEACHER, "{")).status).toBe(400);
    expect(
      (await call("POST", courseUrl(), TEACHER, send("x", QUESTIONS), "text/plain")).status,
    ).toBe(415);
    expect(
      (await call("POST", `${oneUrl(ID(1))}/state`, TEACHER, '{"state":"open","x":1}')).status,
    ).toBe(422);
    expect(writes).toBe(before);
    expect(stored.size).toBe(0);
  });

  it("counts an accepted write as session activity, and nothing else", async () => {
    await call("GET", courseUrl(), TEACHER);
    await make(TEACHER, []); // refused: 422
    await make(STUDENT); // refused: 404
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(touches).toBe(0);
    expect((await make()).status).toBe(201);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(touches).toBe(1);
  });

  it("is 401 without a live session, and 503 when the database is down", async () => {
    expect((await call("GET", courseUrl())).status).toBe(401);
    expect((await call("GET", courseUrl(), SIGNED_OUT)).status).toBe(401);
    expect((await call("GET", courseUrl(), BROKEN)).status).toBe(503);
    expect((await make(BROKEN)).status).toBe(503);
  });
});
