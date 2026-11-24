import { afterEach, expect, it, vi } from "vitest";

import { ROUTES } from "../../contracts/index.ts";
import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createTeacherWorkingCriteriaRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "E".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const DOCUMENT = "izmisljeni-rad-0001";
const HEADERS = { cookie: COOKIE, origin: ORIGIN, "content-type": "application/json" };
const IDS = ["topic", "structure", "sources", "method", "language", "formatting"];

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
    routes: createTeacherWorkingCriteriaRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}/api/v1/teacher/works/${DOCUMENT}/working-criteria`;
  return { list: base, one: (id: string) => `${base}/${id}`, spy };
}

const put = (url: string, body: unknown, headers: Record<string, string> = HEADERS) =>
  fetch(url, { method: "PUT", headers, body: JSON.stringify(body) });
const refusal = (code: string) => Object.assign(new Error("refused"), { code });
const rows = (set: Record<string, [number | null, string | null]> = {}) =>
  IDS.map((id) => ({ id, assessment: set[id]?.[0] ?? null, note: set[id]?.[1] ?? null }));

it("reads the six criteria in order and saves, replaces and clears one", async () => {
  const state: Record<string, [number | null, string | null]> = {};
  const { list, one, spy } = await fixture(async (sql, values) => {
    if (sql.includes("list_working_criteria(")) return rows(state);
    state[String(values?.[1])] = [values?.[2] as number | null, values?.[3] as string | null];
    return [{ id: values?.[1], assessment: values?.[2], note: values?.[3] }];
  });
  const first = await fetch(list, { headers: { cookie: COOKIE } });
  expect(first.status).toBe(200);
  const body = (await first.json()) as { criteria: { id: string; label: string }[] };
  expect(body.criteria.map((c) => c.id)).toEqual(IDS);
  expect(body.criteria[0]!.label).toBe("workingCriteria.topic");
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("list_working_criteria("), [DOCUMENT]);

  const saved = await put(one("sources"), { assessment: 1, note: "Izmišljena napomena." });
  expect(saved.status).toBe(200);
  expect(await saved.json()).toEqual({
    id: "sources",
    label: "workingCriteria.sources",
    assessment: 1,
    note: "Izmišljena napomena.",
  });
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("save_working_criterion("), [
    DOCUMENT,
    "sources",
    1,
    "Izmišljena napomena.",
  ]);
  const zero = await put(one("language"), { assessment: 0, note: null });
  expect((await zero.json()) as object).toMatchObject({ assessment: 0, note: null });
  const reread = (await (await fetch(list, { headers: { cookie: COOKIE } })).json()) as {
    criteria: { id: string; assessment: number | null; note: string | null }[];
  };
  expect(reread.criteria.find((c) => c.id === "sources")).toMatchObject({ assessment: 1 });
  expect(reread.criteria.find((c) => c.id === "language")?.assessment).toBe(0);

  const cleared = await put(one("sources"), { assessment: null, note: null });
  expect(await cleared.json()).toMatchObject({ id: "sources", assessment: null, note: null });
});

it("answers the same 404 for the student, another teacher, an unknown criterion", async () => {
  const { list, one, spy } = await fixture(async () => {
    throw refusal("ZD403");
  });
  expect((await fetch(list, { headers: { cookie: COOKIE } })).status).toBe(404);
  expect((await put(one("sources"), { assessment: 1, note: null })).status).toBe(404);
  const before = spy.mock.calls.length;
  expect((await put(one("ocjena"), { assessment: 1, note: null })).status).toBe(404);
  expect(spy.mock.calls.length).toBe(before);
});

it("refuses before the database: no session, wrong body, assessment 3, blank note", async () => {
  const { list, one, spy } = await fixture(async () => rows());
  expect((await fetch(list)).status).toBe(401);
  expect(
    (
      await put(
        one("sources"),
        { assessment: 1, note: null },
        { origin: ORIGIN, "content-type": "application/json" },
      )
    ).status,
  ).toBe(401);
  expect((await put(one("sources"), { assessment: 3, note: null })).status).toBe(422);
  expect((await put(one("sources"), { assessment: 1 })).status).toBe(422);
  expect((await put(one("sources"), { assessment: 1, note: null, points: 5 })).status).toBe(422);
  expect((await put(one("sources"), { assessment: 1, note: "   " })).status).toBe(422);
  expect((await put(one("sources"), { assessment: 1, note: "a‮b" })).status).toBe(422);
  expect(spy).not.toHaveBeenCalled();
});

it("maps database refusals and a malformed answer", async () => {
  let mode = "ZD422";
  const { list, one } = await fixture(async (sql) => {
    if (mode === "bad" && sql.includes("list_")) return rows().slice(0, 5);
    if (mode === "ZD401") throw refusal("ZD401");
    throw refusal(mode);
  });
  expect((await put(one("sources"), { assessment: 1, note: null })).status).toBe(422);
  mode = "ZD401";
  expect((await fetch(list, { headers: { cookie: COOKIE } })).status).toBe(401);
  mode = "bad";
  expect((await fetch(list, { headers: { cookie: COOKIE } })).status).toBe(503);
  mode = "XX000";
  expect((await put(one("sources"), { assessment: 1, note: null })).status).toBe(503);
});

// SRV-V17-RUBRIC-DEF: the rubric of an assignment is a separate, student-visible thing (the words of
// the criteria and levels the teacher chose, before submitting). It is the only student route that
// may speak of criteria, and it must hold no assessment, working note or mark of any work.
const RUBRIC_ROUTE = "student.assignment-rubric.get";

it("keeps criteria out of every student-facing and export contract", () => {
  const found = ROUTES.filter(
    (route) => route.access !== "course_teacher" && route.access !== "teacher",
  )
    .filter((route) => route.id !== RUBRIC_ROUTE)
    .filter((route) =>
      /criteri|assessment|working/iu.test(JSON.stringify([route.responses, route.request])),
    )
    .map((route) => route.id);
  expect(found).toEqual([]);
});

it("lets the student rubric carry no assessment, working note or mark", () => {
  const route = ROUTES.find((r) => r.id === RUBRIC_ROUTE)!;
  expect(JSON.stringify(route.responses)).not.toMatch(
    /assessment|working|note|mark|points|score|grade/iu,
  );
});
