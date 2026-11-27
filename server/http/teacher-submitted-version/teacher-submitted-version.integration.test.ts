import { createHash } from "node:crypto";

import { afterEach, expect, it, vi } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createTeacherSubmittedVersionRoutesFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "E".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const DOCUMENT = "izmisljeni-rad-0001";
const STUDENT = "aaaaaaaa-0000-4000-8000-000000000001";
const ASSIGNMENT = "bbbbbbbb-0000-4000-8000-000000000002";
const TEXT = JSON.stringify({
  nodes: [
    {
      children: [{ marks: [], text: "Izmišljeni predani tekst.", type: "text" }],
      id: "a0000000-0000-4000-8000-000000000001",
      type: "paragraph",
    },
  ],
  schemaVersion: 1,
});
const HASH = createHash("sha256").update(TEXT).digest("hex");

let running: Running | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Rows = Record<string, unknown>[];
// Database column names are snake_case; keys are built from pairs.
const workRow = (state: string): Rows => [
  Object.fromEntries([
    ["assignment_id", ASSIGNMENT],
    ["student_id", STUDENT],
    ["state", state],
  ]),
];
type Query = (sql: string, values?: readonly unknown[]) => Promise<Rows>;

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
    routes: createTeacherSubmittedVersionRoutesFor({ withActor }),
  });
  const url = (id: string, revision: string) =>
    `http://127.0.0.1:${running!.port}/api/v1/teacher/works/${id}/submitted-versions/${revision}`;
  return { url, spy };
}

type Scenario = {
  work?: Rows;
  submission?: Rows;
  text?: Rows;
};

// The database as the three RPCs answer it for a teacher of the course.
function database(scenario: Scenario = {}): Query {
  return async (sql) => {
    if (sql.includes("app.teacher_work_get")) {
      return scenario.work ?? workRow("predano");
    }
    if (sql.includes("app.assignment_submissions")) {
      return scenario.submission ?? [{ submitted: true, revision: "2" }];
    }
    return scenario.text ?? [{ outcome: "submitted", content_hash: HASH, body: TEXT }];
  };
}

const refusal = (code: string) => Object.assign(new Error("refused"), { code });
const get = (url: string, cookie = true) =>
  fetch(url, cookie ? { headers: { cookie: COOKIE } } : {});

it("gives the submitted revision to a teacher of the course", async () => {
  const { url, spy } = await fixture(database());
  const response = await get(url(DOCUMENT, "2"));
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ revision: 2, document: TEXT });
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("app.teacher_work_get("), [DOCUMENT]);
  expect(spy).toHaveBeenCalledWith(expect.stringContaining("collaboration.read_live_state("), [
    DOCUMENT,
  ]);
});

it("answers 404 for a teacher of another course (the work is not readable)", async () => {
  const { url, spy } = await fixture(database({ work: [] }));
  expect((await get(url(DOCUMENT, "2"))).status).toBe(404);
  // No text is read, so nothing is logged and nothing leaks.
  expect(spy).toHaveBeenCalledTimes(1);
});

it("answers 404 when the database refuses the read of the text (the student of the work)", async () => {
  const { url } = await fixture(async (sql, values) => {
    if (sql.includes("read_live_state")) throw refusal("ZD403");
    return database()(sql, values);
  });
  expect((await get(url(DOCUMENT, "2"))).status).toBe(404);
});

it("answers 404 for a work that was not submitted", async () => {
  const notSubmitted = await fixture(
    database({
      work: workRow("nije_predano"),
    }),
  );
  expect((await get(notSubmitted.url(DOCUMENT, "2"))).status).toBe(404);
  expect(notSubmitted.spy).toHaveBeenCalledTimes(1);
  await running?.close();

  const noRow = await fixture(database({ submission: [{ submitted: false, revision: null }] }));
  expect((await get(noRow.url(DOCUMENT, "2"))).status).toBe(404);
});

it("answers 404 for a revision that is not the submitted one", async () => {
  const { url, spy } = await fixture(database());
  expect((await get(url(DOCUMENT, "1"))).status).toBe(404);
  expect((await get(url(DOCUMENT, "3"))).status).toBe(404);
  // The text is read only for the submitted revision.
  expect(spy).not.toHaveBeenCalledWith(
    expect.stringContaining("read_live_state"),
    expect.anything(),
  );
});

it("answers 404 when the text is a live text, not the submission", async () => {
  const { url } = await fixture(
    database({ text: [{ outcome: "state", content_hash: HASH, body: TEXT }] }),
  );
  expect((await get(url(DOCUMENT, "2"))).status).toBe(404);
});

it("answers 503 when the text does not match its hash or is unavailable", async () => {
  const bad = await fixture(
    database({ text: [{ outcome: "submitted", content_hash: "0".repeat(64), body: TEXT }] }),
  );
  expect((await get(bad.url(DOCUMENT, "2"))).status).toBe(503);
  await running?.close();

  const gone = await fixture(
    database({ text: [{ outcome: "unavailable", content_hash: null, body: null }] }),
  );
  expect((await get(gone.url(DOCUMENT, "2"))).status).toBe(503);
  await running?.close();

  const broken = await fixture(async () => {
    throw new Error("database down");
  });
  expect((await get(broken.url(DOCUMENT, "2"))).status).toBe(503);
});

it("answers 401 without a session and when the database says so", async () => {
  const { url } = await fixture(database());
  expect((await get(url(DOCUMENT, "2"), false)).status).toBe(401);
  await running?.close();

  const refused = await fixture(async () => {
    throw refusal("ZD401");
  });
  expect((await get(refused.url(DOCUMENT, "2"))).status).toBe(401);
});

it("answers 422 for a bad revision and 404 for a malformed work id", async () => {
  const { url, spy } = await fixture(database());
  for (const revision of ["0", "-1", "01", "abc", "1.5", "99999999999999999"]) {
    expect((await get(url(DOCUMENT, revision))).status).toBe(422);
  }
  expect((await get(url("x".repeat(300), "2"))).status).toBe(404);
  expect(spy).not.toHaveBeenCalled();
});
