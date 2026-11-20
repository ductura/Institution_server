// The consultation record routes over a fake withActor: the cookie, the work
// id, the checked body, the statements and every outcome as the contract's
// status and body. Every value is invented.
import { afterEach, expect, it } from "vitest";

import type { WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createConsultationRecordRoutesFor } from "./index.ts";

const TOKEN = "V".repeat(43);
const COOKIE = `__Host-ductus_session=${TOKEN}`;
const ORIGIN = "https://ductura.example.invalid";
const DOCUMENT = "izmisljeni-rad-0001";
const RECORD = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c11";
const ADDITION = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c21";
const MINUTE = new Date("2026-11-19T09:30:00.000Z");

let running: Running | undefined;
afterEach(async () => {
  await running?.close();
  running = undefined;
});

type Statement = { sql: string; values: readonly unknown[] | undefined };

async function serve(answer: object[] | Error) {
  const statements: Statement[] = [];
  const withActor: WithActor = async (token, run) => {
    expect(token).toBe(TOKEN);
    return run({
      async query<Row>(sql: string, values?: readonly unknown[]) {
        statements.push({ sql, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer as Row[], rowCount: answer.length };
      },
    });
  };
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createConsultationRecordRoutesFor({ withActor }),
  });
  const base = `http://127.0.0.1:${running.port}/api/v1/works`;
  return { base, statements };
}

const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });
const write = (url: string, body: unknown, cookie: string | null = COOKIE) =>
  fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      ...(cookie === null ? {} : { cookie }),
    },
    body: JSON.stringify(body),
  });
const row = (additionId: string | null) => ({
  recordId: RECORD,
  heldOn: "2026-11-18",
  revision: "3",
  topic: "Izmišljena tema",
  agreement: "Dogovor.",
  additionId,
  additionBody: additionId === null ? null : "Dopuna nastavnika.",
  additionMinute: additionId === null ? null : MINUTE,
});
const RECORD_BODY = {
  heldOn: "2026-11-18",
  revision: 3,
  topic: "Izmišljena tema",
  agreement: "Dogovor.",
};

it("lists the records with their additions for whoever may read the work", async () => {
  const { base, statements } = await serve([row(ADDITION)]);
  const response = await fetch(`${base}/${DOCUMENT}/consultation-records`, {
    headers: { cookie: COOKIE },
  });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    records: [
      {
        id: RECORD,
        heldOn: "2026-11-18",
        revision: 3,
        topic: "Izmišljena tema",
        agreement: "Dogovor.",
        additions: [
          { id: ADDITION, text: "Dopuna nastavnika.", createdAt: "2026-11-19T09:30:00.000Z" },
        ],
      },
    ],
  });
  expect(statements[0]?.values).toEqual([DOCUMENT]);
});

it("answers 401 without a session and 404 for a work id that is not one or a refused work", async () => {
  const { base } = await serve(coded("ZD403"));
  expect((await fetch(`${base}/${DOCUMENT}/consultation-records`)).status).toBe(401);
  expect(
    (await fetch(`${base}/%20x/consultation-records`, { headers: { cookie: COOKIE } })).status,
  ).toBe(404);
  expect(
    (await fetch(`${base}/${DOCUMENT}/consultation-records`, { headers: { cookie: COOKIE } }))
      .status,
  ).toBe(404);
});

it("creates a record: 201 with the record and no additions", async () => {
  const { base, statements } = await serve([{ id: RECORD }]);
  const response = await write(`${base}/${DOCUMENT}/consultation-records`, RECORD_BODY);
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ id: RECORD, ...RECORD_BODY, additions: [] });
  expect(statements[0]?.values).toEqual([DOCUMENT, "2026-11-18", 3, "Izmišljena tema", "Dogovor."]);
});

it("refuses an empty topic, a date that does not exist, an extra field and a control character with 422, before the database", async () => {
  const { base, statements } = await serve([{ id: RECORD }]);
  const url = `${base}/${DOCUMENT}/consultation-records`;
  for (const body of [
    { ...RECORD_BODY, topic: "" },
    { ...RECORD_BODY, topic: "   " },
    { ...RECORD_BODY, heldOn: "2026-02-30" },
    { ...RECORD_BODY, extra: 1 },
    { ...RECORD_BODY, topic: "a\u0007b" },
    { ...RECORD_BODY, revision: 0 },
  ]) {
    expect((await write(url, body)).status).toBe(422);
  }
  expect(statements).toEqual([]);
});

it("maps a refusal of the database: ZD422 to 422 (a revision of another work), ZD403 to 404, ZD401 to 401", async () => {
  const url = (base: string) => `${base}/${DOCUMENT}/consultation-records`;
  for (const [code, status] of [
    ["ZD422", 422],
    ["ZD403", 404],
    ["ZD401", 401],
  ] as const) {
    const { base } = await serve(coded(code));
    expect((await write(url(base), RECORD_BODY)).status).toBe(status);
    await running?.close();
    running = undefined;
  }
});

it("adds an addition: 201 with the id, the text and a whole minute; blank text is 422", async () => {
  const { base, statements } = await serve([{ id: ADDITION, createdAt: MINUTE }]);
  const url = `${base}/${DOCUMENT}/consultation-records/${RECORD}/additions`;
  const response = await write(url, { text: "Dopuna nastavnika." });
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({
    id: ADDITION,
    text: "Dopuna nastavnika.",
    createdAt: "2026-11-19T09:30:00.000Z",
  });
  expect(statements[0]?.values).toEqual([DOCUMENT, RECORD, "Dopuna nastavnika."]);
  for (const text of ["", "  \n "]) expect((await write(url, { text })).status).toBe(422);
  expect(statements).toHaveLength(1);
  expect((await write(url, { text: "x" }, null)).status).toBe(401);
});

it("answers 404 for a record id that is not one and 503 for a failing database", async () => {
  const { base } = await serve(new Error("izmišljeno"));
  expect(
    (await write(`${base}/${DOCUMENT}/consultation-records/nije-id/additions`, { text: "x" }))
      .status,
  ).toBe(404);
  expect((await write(`${base}/${DOCUMENT}/consultation-records`, RECORD_BODY)).status).toBe(503);
});
