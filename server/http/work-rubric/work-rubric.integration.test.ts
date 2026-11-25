import { afterEach, expect, it, vi } from "vitest";

import { ROUTES } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createWorkRubricRoutesFor } from "./index.ts";

// SRV-V17-RUBRIC-LEVEL: the HTTP edge of the teacher's marks of a level per criterion of the
// assignment's rubric on a work. The database is a stand-in that answers as the RPCs do; the
// rules themselves are in db/main/tests/251-work-rubric-level.sql.
const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "F".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const DOCUMENT = "izmisljeni-rad-0001";
const HEADERS = { cookie: COOKIE, origin: ORIGIN, "content-type": "application/json" };
const DEFAULT_IDS = ["topic", "structure", "sources", "method", "language", "formatting"];

let running: Running | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Query = (sql: string, values?: readonly unknown[]) => Promise<object[]>;

async function fixture(query: Query) {
  const spy = vi.fn(query);
  const withActor: WithActor = async (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const rows = await spy(sql, values);
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createWorkRubricRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}/api/v1/teacher/works/${DOCUMENT}/rubric`;
  return { list: base, one: (id: string) => `${base}/${id}`, spy };
}

const put = (url: string, body: unknown, headers: Record<string, string> = HEADERS) =>
  fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
const refusal = (code: string) => Object.assign(new Error("refused"), { code });
type Marks = Record<string, [number | null, string | null]>;
const rows = (ids: string[], version: number, set: Marks = {}) =>
  ids.map((id) => ({
    version,
    id,
    level: set[id]?.[0] ?? null,
    note: set[id]?.[1] ?? null,
  }));

it("reads the marks of the latest version in order and saves, replaces and clears one", async () => {
  const state: Marks = {};
  const { list, one, spy } = await fixture(async (sql, values) => {
    if (sql.includes("list_work_rubric(")) return rows(["tema", "ton"], 3, state);
    state[String(values?.[1])] = [values?.[2] as number | null, values?.[3] as string | null];
    return [{ version: 3, id: values?.[1], level: values?.[2], note: values?.[3] }];
  });
  const first = await fetch(list, { headers: { cookie: COOKIE } });
  expect(first.status).toBe(200);
  expect(await first.json()).toEqual({
    rubricVersion: 3,
    marks: [
      { criterionId: "tema", level: null, note: null },
      { criterionId: "ton", level: null, note: null },
    ],
  });
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("list_work_rubric("), [DOCUMENT]);

  const saved = await put(one("ton"), { level: 2, note: "Izmišljena napomena." });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({
    criterionId: "ton",
    level: 2,
    note: "Izmišljena napomena.",
  });
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("save_work_rubric_mark("), [
    DOCUMENT,
    "ton",
    2,
    "Izmišljena napomena.",
  ]);
  const zero = await put(one("tema"), { level: 0, note: null });
  expect((await zero.json()) as object).toMatchObject({ criterionId: "tema", level: 0 });
  const reread = (await (await fetch(list, { headers: { cookie: COOKIE } })).json()) as {
    marks: { criterionId: string; level: number | null }[];
  };
  expect(reread.marks.map((m) => m.level)).toEqual([0, 2]);

  const cleared = await put(one("ton"), { level: null, note: null });
  expect(await cleared.json()).toEqual({ criterionId: "ton", level: null, note: null });
});

it("reads the six default criteria at version 0 while no rubric is set", async () => {
  const { list } = await fixture(async () => rows(DEFAULT_IDS, 0));
  const body = (await (await fetch(list, { headers: { cookie: COOKIE } })).json()) as {
    rubricVersion: number;
    marks: { criterionId: string }[];
  };
  expect(body.rubricVersion).toBe(0);
  expect(body.marks.map((m) => m.criterionId)).toEqual(DEFAULT_IDS);
});

it("answers the same 404 for the student, another teacher, an unknown work and criterion", async () => {
  const { list, one, spy } = await fixture(async () => {
    throw refusal("ZD403");
  });
  expect((await fetch(list, { headers: { cookie: COOKIE } })).status).toBe(404);
  expect((await put(one("ton"), { level: 1, note: null })).status).toBe(404);
  // A criterion id that is no id at all never reaches the database.
  const before = spy.mock.calls.length;
  expect((await put(one("Ocjena!"), { level: 1, note: null })).status).toBe(404);
  expect(spy.mock.calls.length).toBe(before);
  // A malformed work id is the same 404.
  const base = list.replace(DOCUMENT, "%20");
  expect((await fetch(base, { headers: { cookie: COOKIE } })).status).toBe(404);
});

it("refuses before the database: no session, wrong body, level 3, blank note", async () => {
  const { list, one, spy } = await fixture(async () => rows(DEFAULT_IDS, 0));
  expect((await fetch(list)).status).toBe(401);
  expect(
    (
      await put(
        one("topic"),
        { level: 1, note: null },
        { origin: ORIGIN, "content-type": "application/json" },
      )
    ).status,
  ).toBe(401);
  expect((await put(one("topic"), { level: 3, note: null })).status).toBe(422);
  expect((await put(one("topic"), { level: 1 })).status).toBe(422);
  expect((await put(one("topic"), { level: 1, note: null, points: 5 })).status).toBe(422);
  expect((await put(one("topic"), { level: 1, note: "   " })).status).toBe(422);
  expect((await put(one("topic"), { level: 1, note: "a‮b" })).status).toBe(422);
  expect(spy).not.toHaveBeenCalled();
});

it("maps database refusals and malformed answers", async () => {
  let mode = "ZD422";
  const { list, one } = await fixture(async (sql) => {
    if (mode === "empty" && sql.includes("list_")) return [];
    if (mode === "mixed" && sql.includes("list_")) {
      return [...rows(["tema"], 1), ...rows(["ton"], 2)];
    }
    if (mode === "duplicate" && sql.includes("list_")) return rows(["tema", "tema"], 1);
    if (mode === "other" && sql.includes("save_")) return rows(["ton"], 1);
    throw refusal(mode);
  });
  expect((await put(one("topic"), { level: 1, note: null })).status).toBe(422);
  mode = "ZD401";
  expect((await fetch(list, { headers: { cookie: COOKIE } })).status).toBe(401);
  for (const bad of ["empty", "mixed", "duplicate"]) {
    mode = bad;
    expect((await fetch(list, { headers: { cookie: COOKIE } })).status).toBe(503);
  }
  mode = "other";
  expect((await put(one("topic"), { level: 1, note: null })).status).toBe(503);
  mode = "XX000";
  expect((await put(one("topic"), { level: 1, note: null })).status).toBe(503);
});

it("keeps marks out of every student-facing and export contract", () => {
  const ids = ["teacher.work-rubric.get", "teacher.work-rubric-mark.put"];
  const found = ROUTES.filter((route) => !ids.includes(route.id))
    .filter((route) => route.access !== "course_teacher" && route.access !== "teacher")
    .filter((route) =>
      /rubricVersion|criterionId|work-rubric/iu.test(
        JSON.stringify([route.responses, route.request]),
      ),
    )
    .map((route) => route.id);
  expect(found).toEqual([]);
  for (const id of ids)
    expect(ROUTES.find((route) => route.id === id)?.access).toBe("course_teacher");
});

it("carries no number, sum, grade or rank in the answers", () => {
  for (const route of ROUTES.filter((r) => r.id.startsWith("teacher.work-rubric"))) {
    expect(JSON.stringify(route.responses)).not.toMatch(/points|score|grade|sum|rank|weight/iu);
  }
});
