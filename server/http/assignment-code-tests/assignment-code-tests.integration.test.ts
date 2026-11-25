// SRV-V21-KOD-TESTOVI-RUTA: the three code-test routes on a real server and pipeline, over a fake
// withActor that answers like the database (the SQL itself is
// db/main/tests/254-assignment-code-tests.sql): a teacher adds revisions, a teacher and a student
// read the latest on either path, a student who writes is 403, everyone else is 404, and input
// the route refuses never reaches the database.
import { request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import { createDatabases, createLayers, type Running, startServer } from "../index.ts";

import { createAssignmentCodeTestsRoutesFor } from "./index.ts";

const ASSIGNMENT = "00000000-0000-4000-8000-0000000000a1";
const OTHER = "00000000-0000-4000-8000-0000000000a2";
const ORIGIN = "https://ductura.example.invalid";
const TEACHER = "izmisljeni-token-nastavnika-000000000000001";
const STUDENT = "izmisljeni-token-studenta-00000000000000001";
const STRANGER = "izmisljeni-token-stranca-000000000000000001";
const SIGNED_OUT = "izmisljeni-token-odjavljen-0000000000000000";
const BROKEN = "izmisljeni-token-pokvaren-00000000000000000";

const test = (id: string, input: unknown = [1, 2], expected: unknown = 3) => ({
  id,
  title: `Izmišljeni test ${id}`,
  input,
  expected,
});

type Row = { revisionNo: number; language: string; tests: unknown[] };
const stored = new Map<string, Row>();
let touches = 0;
let writes = 0;
/** When set, the fake database refuses the next write as too large (ZD422). */
let tooLarge = false;
const roles: Record<string, string> = { [TEACHER]: "teacher", [STUDENT]: "student" };
const refuse = (code: string) => Object.assign(new Error(code), { code });

const withActor = (async (token: string, fn: (tx: unknown) => Promise<unknown>) => {
  if (token === SIGNED_OUT) throw refuse("ZD401");
  if (token === BROKEN) throw new Error("down");
  return fn({
    async query(sql: string, params: unknown[] = []) {
      const id = params[0] as string;
      const role = roles[token];
      if (sql.includes("get_assignment_code_tests")) {
        if (role === undefined || id !== ASSIGNMENT) throw refuse("ZD404");
        return { rows: stored.has(id) ? [stored.get(id)] : [] };
      }
      if (sql.includes("set_assignment_code_tests")) {
        writes += 1;
        if (role === undefined || id !== ASSIGNMENT) throw refuse("ZD404");
        if (role === "student") throw refuse("ZD403");
        if (tooLarge) throw refuse("ZD422");
        const row = {
          revisionNo: (stored.get(id)?.revisionNo ?? 0) + 1,
          language: params[1] as string,
          tests: JSON.parse(params[2] as string) as unknown[],
        };
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
  writes = 0;
  tooLarge = false;
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
    routes: createAssignmentCodeTestsRoutesFor({ withActor }),
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
const teacherUrl = (id: string) => `/api/v1/teacher/assignments/${id}/code-tests`;
const studentUrl = (id: string) => `/api/v1/student/assignments/${id}/code-tests`;
const put = (token: string | undefined, tests: unknown, id = ASSIGNMENT, language = "javascript") =>
  call("PUT", teacherUrl(id), token, JSON.stringify({ language, tests }));

describe("assignment code tests", () => {
  it("counts an accepted PUT as session activity, and nothing else", async () => {
    await call("GET", teacherUrl(ASSIGNMENT), TEACHER);
    await put(TEACHER, [test("a"), test("a")]); // refused: 422
    await put(STUDENT, [test("a")]); // refused: 403
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(touches).toBe(0);
    expect((await put(TEACHER, [test("a")])).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(touches).toBe(1);
  });

  it("is revision 0 with no tests on both paths while none is set", async () => {
    const empty = { status: 200, body: { revisionNo: 0, language: "javascript", tests: [] } };
    expect(await call("GET", teacherUrl(ASSIGNMENT), TEACHER)).toEqual(empty);
    expect(await call("GET", studentUrl(ASSIGNMENT), STUDENT)).toEqual(empty);
  });

  it("adds revisions and shows the latest to the student, any JSON value kept", async () => {
    const odd = test("rubni-slucaj", { lista: [null, true, "x"], broj: -1.5 }, null);
    expect(await put(TEACHER, [test("zbroj"), odd])).toEqual({
      status: 200,
      body: { revisionNo: 1, language: "javascript", tests: [test("zbroj"), odd] },
    });
    expect((await put(TEACHER, [test("drugi")])).body.revisionNo).toBe(2);
    expect((await put(TEACHER, [])).body).toEqual({
      revisionNo: 3,
      language: "javascript",
      tests: [],
    });
    expect((await put(TEACHER, [test("cetvrti")])).body.revisionNo).toBe(4);
    const latest = { revisionNo: 4, language: "javascript", tests: [test("cetvrti")] };
    expect(await call("GET", studentUrl(ASSIGNMENT), STUDENT)).toEqual({
      status: 200,
      body: latest,
    });
    expect(await call("GET", teacherUrl(ASSIGNMENT), TEACHER)).toEqual({
      status: 200,
      body: latest,
    });
  });

  it("reads the same on either path for a teacher and a student of the assignment", async () => {
    await put(TEACHER, [test("a")]);
    const answers = await Promise.all([
      call("GET", teacherUrl(ASSIGNMENT), STUDENT),
      call("GET", studentUrl(ASSIGNMENT), TEACHER),
      call("GET", studentUrl(ASSIGNMENT), STUDENT),
    ]);
    expect(answers.map((a) => a.status)).toEqual([200, 200, 200]);
    expect(new Set(answers.map((a) => JSON.stringify(a.body))).size).toBe(1);
  });

  it("answers 422 invalid_code_tests for more than 10 tests or a repeated id, and writes nothing", async () => {
    const eleven = Array.from({ length: 11 }, (_, n) => test(`t${n}`));
    for (const bad of [eleven, [...eleven.slice(0, 10), { nope: 1 }], [test("a"), test("a")]]) {
      expect(await put(TEACHER, bad)).toMatchObject({
        status: 422,
        body: { code: "invalid_code_tests" },
      });
    }
    expect(
      (
        await put(
          TEACHER,
          Array.from({ length: 10 }, (_, n) => test(`t${n}`)),
        )
      ).status,
    ).toBe(200);
    expect(writes).toBe(1);
  });

  it("answers 422 invalid_code_tests when the database finds the tests too large", async () => {
    tooLarge = true;
    expect(await put(TEACHER, [test("a")])).toMatchObject({
      status: 422,
      body: { code: "invalid_code_tests" },
    });
    expect(stored.size).toBe(0);
  });

  it("answers 422 invalid_input for any other shape, and nothing reaches the database", async () => {
    const noInput: Record<string, unknown> = test("a");
    delete noInput.input;
    const noExpected: Record<string, unknown> = test("a");
    delete noExpected.expected;
    for (const bad of [
      "nije-polje",
      [{ ...test("a"), extra: 1 }],
      [{ ...test("a"), id: "A b" }],
      [{ ...test("a"), id: "" }],
      [{ ...test("a"), title: "" }],
      [{ ...test("a"), title: "x".repeat(121) }],
      [noInput],
      [noExpected],
      [{ ...test("a"), title: "a\u0000b" }],
      [test("a", "a\u0000b")],
    ]) {
      expect(await put(TEACHER, bad)).toMatchObject({
        status: 422,
        body: { code: "invalid_input" },
      });
    }
    expect((await put(TEACHER, [test("a")], ASSIGNMENT, "python")).body.code).toBe("invalid_input");
    for (const body of [
      { language: "javascript", tests: [test("a")], extra: 1 },
      { tests: [test("a")] },
      { language: "javascript" },
      [],
      null,
    ]) {
      expect(
        (await call("PUT", teacherUrl(ASSIGNMENT), TEACHER, JSON.stringify(body))).body.code,
      ).toBe("invalid_input");
    }
    expect(writes).toBe(0);
  });

  it("answers 413 for a body over 16 KiB", async () => {
    const big = [test("a", "x".repeat(16_400))];
    expect((await put(TEACHER, big)).status).toBe(413);
    expect(writes).toBe(0);
  });

  it("answers 415 and 400 for a wrong media type and broken JSON", async () => {
    expect((await call("PUT", teacherUrl(ASSIGNMENT), TEACHER, "x", "text/plain")).status).toBe(
      415,
    );
    expect((await call("PUT", teacherUrl(ASSIGNMENT), TEACHER, "{")).status).toBe(400);
  });

  it("answers 403 forbidden to a student of the assignment who writes, and stores nothing", async () => {
    expect(await put(STUDENT, [test("a")])).toMatchObject({
      status: 403,
      body: { code: "forbidden" },
    });
    expect(stored.size).toBe(0);
  });

  it("answers the same 404 to a stranger, to an unknown and to a malformed assignment", async () => {
    await put(TEACHER, [test("a")]);
    const answers = await Promise.all([
      call("GET", teacherUrl(ASSIGNMENT), STRANGER),
      call("GET", studentUrl(ASSIGNMENT), STRANGER),
      call("GET", teacherUrl(OTHER), TEACHER),
      call("GET", studentUrl(OTHER), STUDENT),
      call("GET", teacherUrl("nije-uuid"), TEACHER),
      call("GET", studentUrl("nije-uuid"), STUDENT),
      put(STRANGER, [test("b")]),
      put(TEACHER, [test("b")], OTHER),
      put(STUDENT, [test("b")], OTHER),
      put(TEACHER, [test("b")], "nije-uuid"),
    ]);
    expect(answers.map((a) => a.status)).toEqual(Array(10).fill(404));
    expect(new Set(answers.map((a) => a.body.code)).size).toBe(1);
    expect(stored.get(ASSIGNMENT)!.revisionNo).toBe(1);
  });

  it("answers 401 without a session or with a signed-out one, and 503 when the database fails", async () => {
    expect((await call("GET", teacherUrl(ASSIGNMENT))).status).toBe(401);
    expect((await call("GET", studentUrl(ASSIGNMENT), SIGNED_OUT)).status).toBe(401);
    expect((await put(undefined, [test("a")])).status).toBe(401);
    expect((await put(SIGNED_OUT, [test("a")])).status).toBe(401);
    expect((await call("GET", studentUrl(ASSIGNMENT), BROKEN)).status).toBe(503);
    expect((await put(BROKEN, [test("a")])).status).toBe(503);
  });
});
