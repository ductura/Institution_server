// SRV-V17-RUBRIC-DEF: the three rubric routes on a real server and pipeline, over a fake
// withActor that answers like the database (the SQL itself is db/main/tests/247-assignment-rubric.sql):
// a teacher reads and adds versions, a student reads (the six default criteria while none is set),
// everyone else reads 404, a stale version is 409, input outside the contract is 422, and nobody
// reads a mark, a number or a grade.
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createAssignmentRubricRoutesFor } from "./index.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const ORIGIN = "https://ductura.example.invalid";
const TEACHER = "izmisljeni-token-nastavnika-000000000000001";
const STUDENT = "izmisljeni-token-studenta-00000000000000001";
const STRANGER = "izmisljeni-token-stranca-000000000000000001";
const SIGNED_OUT = "izmisljeni-token-odjavljen-0000000000000000";
const BROKEN = "izmisljeni-token-pokvaren-00000000000000000";

const level = { label: "Dobro", descriptor: "Izmišljeni opis." };
const criterion = (id: string) => ({
  id,
  title: `Izmišljeni ${id}`,
  levels: [level, level, level],
});

type Row = { version: number; criteria: unknown[] };
const stored = new Map<string, Row>();
let touches = 0;
const roles: Record<string, string> = { [TEACHER]: "teacher", [STUDENT]: "student" };
const refuse = (code: string) => Object.assign(new Error(code), { code });

const withActor = (async (token: string, fn: (tx: unknown) => Promise<unknown>) => {
  if (token === SIGNED_OUT) throw refuse("ZD401");
  if (token === BROKEN) throw new Error("down");
  return fn({
    async query(sql: string, params: unknown[] = []) {
      const id = params[0] as string;
      const role = roles[token];
      const allowed = (want: string) => {
        if (role !== want || id !== ASSIGNMENT) throw refuse("ZD404");
      };
      if (sql.includes("read_assignment_rubric_teacher")) {
        allowed("teacher");
        return { rows: stored.has(id) ? [stored.get(id)] : [] };
      }
      if (sql.includes("read_assignment_rubric_student")) {
        allowed("student");
        return { rows: stored.has(id) ? [stored.get(id)] : [] };
      }
      if (sql.includes("publish_assignment_rubric")) {
        allowed("teacher");
        const latest = stored.get(id)?.version ?? 0;
        if (params[1] !== latest) throw refuse("ZD409");
        const row = { version: latest + 1, criteria: JSON.parse(params[2] as string) as unknown[] };
        stored.set(id, row);
        return { rows: [row] };
      }
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
  touches = 0;
});

async function call(
  method: "GET" | "PUT",
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
    routes: createAssignmentRubricRoutesFor({ withActor }),
  });
  return new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token !== undefined) headers.cookie = `__Host-ductus_session=${token}`;
    if (method === "PUT") {
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
const teacherUrl = (id: string) => `/api/v1/teacher/assignments/${id}/rubric`;
const studentUrl = (id: string) => `/api/v1/student/assignments/${id}/rubric`;
const put = (
  token: string | undefined,
  expectedVersion: number,
  criteria: unknown[],
  id = ASSIGNMENT,
) => call("PUT", teacherUrl(id), token, JSON.stringify({ expectedVersion, criteria }));

describe("assignment rubric", () => {
  it("counts an accepted PUT as session activity, and nothing else", async () => {
    await call("GET", teacherUrl(ASSIGNMENT), TEACHER);
    await put(TEACHER, 0, []); // refused: 422
    await put(TEACHER, 5, [criterion("a")]); // refused: 409
    await put(STUDENT, 0, [criterion("a")]); // refused: 404
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(touches).toBe(0);
    expect((await put(TEACHER, 0, [criterion("a")])).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(touches).toBe(1);
  });

  it("is empty for the teacher and the six default criteria for the student while none is set", async () => {
    expect(await call("GET", teacherUrl(ASSIGNMENT), TEACHER)).toEqual({
      status: 200,
      body: { version: 0, criteria: [] },
    });
    const answer = await call("GET", studentUrl(ASSIGNMENT), STUDENT);
    expect(answer.status).toBe(200);
    expect(answer.body.version).toBe(0);
    expect((answer.body.criteria as { id: string; levels: unknown[] }[]).map((c) => c.id)).toEqual([
      "topic",
      "structure",
      "sources",
      "method",
      "language",
      "formatting",
    ]);
    expect(
      (answer.body.criteria as { levels: unknown[] }[]).every((c) => c.levels.length === 3),
    ).toBe(true);
  });

  it("adds versions and shows the latest to the student, without any number or grade", async () => {
    expect(await put(TEACHER, 0, [criterion("tema"), criterion("izvori")])).toMatchObject({
      status: 200,
      body: { version: 1 },
    });
    expect((await put(TEACHER, 1, [criterion("metoda")])).body.version).toBe(2);
    const seen = await call("GET", studentUrl(ASSIGNMENT), STUDENT);
    expect(seen).toEqual({ status: 200, body: { version: 2, criteria: [criterion("metoda")] } });
    expect(JSON.stringify(seen.body)).not.toMatch(/points|score|grade|weight|mark/u);
  });

  it("answers 409 for a stale version and stores nothing", async () => {
    await put(TEACHER, 0, [criterion("tema")]);
    expect((await put(TEACHER, 0, [criterion("drugi")])).status).toBe(409);
    expect(stored.get(ASSIGNMENT)!.version).toBe(1);
  });

  it("answers 422 for input outside the contract, and nothing reaches the database", async () => {
    const extra = { ...criterion("a"), points: 3 };
    const twoLevels = { ...criterion("a"), levels: [level, level] };
    for (const bad of [
      [],
      [extra],
      [twoLevels],
      [{ ...criterion("a"), id: "A b" }],
      Array.from({ length: 13 }, (_, n) => criterion(`c${n}`)),
    ]) {
      expect((await put(TEACHER, 0, bad)).status).toBe(422);
    }
    expect(
      (
        await call(
          "PUT",
          teacherUrl(ASSIGNMENT),
          TEACHER,
          JSON.stringify({ expectedVersion: 0, criteria: [criterion("a")], extra: 1 }),
        )
      ).status,
    ).toBe(422);
    expect(
      (
        await call(
          "PUT",
          teacherUrl(ASSIGNMENT),
          TEACHER,
          JSON.stringify({ expectedVersion: -1, criteria: [criterion("a")] }),
        )
      ).status,
    ).toBe(422);
    const nul = { ...criterion("a"), title: "a\u0000b" };
    expect((await put(TEACHER, 0, [nul])).status).toBe(422);
    expect(stored.size).toBe(0);
  });

  it("answers 415 and 400 for a wrong media type and broken JSON", async () => {
    expect((await call("PUT", teacherUrl(ASSIGNMENT), TEACHER, "x", "text/plain")).status).toBe(
      415,
    );
    expect((await call("PUT", teacherUrl(ASSIGNMENT), TEACHER, "{")).status).toBe(400);
  });

  it("answers the same 404 to a stranger, to the wrong side, to an unknown and to a malformed assignment", async () => {
    await put(TEACHER, 0, [criterion("tema")]);
    const reads = [
      call("GET", teacherUrl(ASSIGNMENT), STUDENT),
      call("GET", studentUrl(ASSIGNMENT), TEACHER),
      call("GET", teacherUrl(ASSIGNMENT), STRANGER),
      call("GET", studentUrl(ASSIGNMENT), STRANGER),
      call("GET", teacherUrl(OTHER), TEACHER),
      call("GET", studentUrl(OTHER), STUDENT),
      call("GET", teacherUrl("nije-uuid"), TEACHER),
      put(STUDENT, 1, [criterion("a")]),
      put(STRANGER, 1, [criterion("a")]),
      put(TEACHER, 0, [criterion("a")], OTHER),
    ];
    const answers = await Promise.all(reads);
    expect(answers.map((a) => a.status)).toEqual(Array(10).fill(404));
    expect(new Set(answers.map((a) => a.body.code)).size).toBe(1);
    expect(stored.get(ASSIGNMENT)!.version).toBe(1);
  });

  it("answers 401 without a session or with a signed-out one, and 503 when the database fails", async () => {
    expect((await call("GET", teacherUrl(ASSIGNMENT))).status).toBe(401);
    expect((await call("GET", studentUrl(ASSIGNMENT), SIGNED_OUT)).status).toBe(401);
    expect((await put(undefined, 0, [criterion("a")])).status).toBe(401);
    expect((await call("GET", studentUrl(ASSIGNMENT), BROKEN)).status).toBe(503);
  });
});
