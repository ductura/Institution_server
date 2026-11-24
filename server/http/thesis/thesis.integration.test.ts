import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createThesisRoutesFor } from "./index.ts";

// SRV-MENTOR-2: the adapter over a scripted database. Every person and id is invented.
const TOKEN = "T".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const MENTOR = "00000000-0000-4000-8000-000000233a01";
const AT = "2026-11-23T10:00:00.000Z";

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Answer = object[] | Error;
async function serve(...answers: Answer[]) {
  await running?.close();
  const query = vi.fn(async (_sql: string, _values?: readonly unknown[]) => {
    const answer = answers.shift() ?? [];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const withActor: WithActor = (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        const rows = await query(sql, values);
        return { rows: rows as Row[], rowCount: rows.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createThesisRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}/api/v1`;
  const send = (method: string, path: string, body?: unknown, contentType = "application/json") =>
    fetch(base + path, {
      method,
      headers: { origin: ORIGIN, cookie: COOKIE, "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
  const get = (path: string) => fetch(base + path, { headers: { cookie: COOKIE } });
  return { send, get, query };
}

const sqlError = (code: string) => Object.assign(new Error("refused"), { code });

it("lists the catalogue of the faculty with dates as ISO text", async () => {
  const { get, query } = await serve([
    {
      code: "prijava-teme",
      version: 1,
      title: "Prijava teme",
      workTypes: ["master_thesis"],
      active: true,
      publishedAt: new Date(AT),
    },
  ]);
  const response = await get("/institution/thesis-forms");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    forms: [
      {
        code: "prijava-teme",
        version: 1,
        title: "Prijava teme",
        workTypes: ["master_thesis"],
        active: true,
        publishedAt: AT,
      },
    ],
  });
  expect(query).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/ FROM app\.read_thesis_forms\(\)$/u),
    undefined,
  );
});

it("gives the consent and answers it with the whole history from the same transaction", async () => {
  const { send, query } = await serve(
    [{}],
    [
      {
        state: "given",
        changedBy: MENTOR,
        changedAt: new Date(AT),
        comment: "Spremno.",
        requiredForSubmission: false,
      },
    ],
    [{ given: true, changedBy: MENTOR, changedAt: new Date(AT), comment: "Spremno." }],
  );
  const response = await send("PUT", "/works/doc%3Aa/mentor-consent", {
    given: true,
    comment: "Spremno.",
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    state: "given",
    changedBy: MENTOR,
    changedAt: AT,
    comment: "Spremno.",
    requiredForSubmission: false,
    history: [{ given: true, changedBy: MENTOR, changedAt: AT, comment: "Spremno." }],
  });
  expect(query.mock.calls[0]).toEqual([
    "SELECT 1 FROM app.set_work_mentor_consent($1, $2, $3)",
    ["doc:a", true, "Spremno."],
  ]);
});

it("passes a missing comment as null and a missing defense date as null", async () => {
  const stage = {
    stage: "submitted_to_office",
    defenseAt: null,
    changedBy: MENTOR,
    changedAt: new Date(AT),
    changedByPart: "mentor",
  };
  const { send, query } = await serve([stage]);
  const response = await send("PUT", "/works/doc-a/thesis-stage", { stage: "submitted_to_office" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    stage: "submitted_to_office",
    defenseAt: null,
    changedBy: MENTOR,
    changedAt: AT,
    changedByPart: "mentor",
  });
  expect(query).toHaveBeenCalledExactlyOnceWith(
    expect.stringMatching(/ FROM app\.set_work_thesis_stage\(\$1, \$2, \$3::timestamptz\)$/u),
    ["doc-a", "submitted_to_office", null],
  );
});

it("refuses bad shapes before the database", async () => {
  const { send, query } = await serve();
  expect(
    (await send("PUT", "/works/doc-a/thesis-stage", { stage: "defense_scheduled" })).status,
  ).toBe(422);
  expect(
    (await send("PUT", "/works/doc-a/thesis-stage", { stage: "none", defenseAt: AT })).status,
  ).toBe(422);
  expect((await send("PUT", "/works/doc-a/thesis-stage", { stage: "graded" })).status).toBe(422);
  expect((await send("PUT", "/works/doc-a/mentor-consent", { given: true, extra: 1 })).status).toBe(
    422,
  );
  expect(
    (await send("PUT", "/works/doc-a/mentor-consent", { given: true, comment: " " })).status,
  ).toBe(422);
  expect(
    (await send("PUT", "/works/doc-a/thesis-forms/prijava-teme", { state: "rejected" })).status,
  ).toBe(422);
  expect(
    (await send("PUT", "/works/doc-a/thesis-forms/Prijava", { state: "submitted" })).status,
  ).toBe(404);
  expect(
    (
      await send("POST", "/institution/thesis-forms", {
        code: "prijava-teme",
        title: "Prijava teme",
        workTypes: ["master_thesis", "master_thesis"],
        active: true,
      })
    ).status,
  ).toBe(422);
  expect(
    (
      await send(
        "PUT",
        "/institution/thesis-settings",
        { mentorConsentRequired: true },
        "text/plain",
      )
    ).status,
  ).toBe(415);
  expect((await send("PUT", "/institution/thesis-settings", "{")).status).toBe(400);
  expect(query).not.toHaveBeenCalled();
});

it("maps the refusals of the database to the words of the contract", async () => {
  const cases: [string, string, unknown, string, number][] = [
    ["PUT", "/works/doc-a/mentor-consent", { given: true }, "ZD403", 403],
    ["PUT", "/works/doc-a/mentor-consent", { given: true }, "ZD409", 409],
    ["PUT", "/works/doc-a/thesis-forms/prijava-teme", { state: "accepted" }, "ZD403", 403],
    ["PUT", "/works/doc-a/thesis-stage", { stage: "defended" }, "ZD404", 404],
    ["PUT", "/institution/thesis-settings", { mentorConsentRequired: true }, "ZD403", 403],
    ["PUT", "/works/doc-a/thesis-stage", { stage: "defended", defenseAt: AT }, "22008", 422],
    // The stage writes nothing twice and has no conflict in its contract: a fault.
    ["PUT", "/works/doc-a/thesis-stage", { stage: "defended" }, "ZD409", 503],
  ];
  for (const [method, path, body, code, status] of cases) {
    const { send } = await serve(sqlError(code));
    expect([path, code, (await send(method, path, body)).status]).toEqual([path, code, status]);
  }
  for (const [path, code, status] of [
    ["/works/doc-a/thesis-forms", "ZD404", 404],
    ["/works/doc-a/mentor-consent", "ZD401", 401],
    ["/institution/thesis-settings", "ZD403", 403],
  ] as const) {
    const { get } = await serve(sqlError(code));
    expect([path, (await get(path)).status]).toEqual([path, status]);
  }
});

it("asks for a session before anything else", async () => {
  const { query } = await serve();
  const response = await fetch(`http://127.0.0.1:${running!.port}/api/v1/works/doc-a/thesis-stage`);
  expect(response.status).toBe(401);
  expect(query).not.toHaveBeenCalled();
});
