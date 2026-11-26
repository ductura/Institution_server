// The questionnaire export route of a teacher (SRV-V18-UPITNIK-IZVOZ) on a real
// server with the real pipeline, over a fake store: a malformed id and a query
// outside the contract never reach the store, includeText reaches it exactly as
// asked, the database's refusals read as 401, 404 and 409, a thin export is 409
// and returns nothing, and an answer outside the contract (a person next to a
// row) is 503. All values are invented.
import { afterEach, describe, expect, it } from "vitest";

import { createDatabases, createLayers, type Running, startServer } from "./index.ts";
import {
  createQuestionnaireExportRoutes,
  type QuestionnaireExportPort,
} from "./questionnaire-export.ts";

const ORIGIN = "https://ductura.example.invalid";
const ID = "00000000-0000-4000-8000-0000000000b1";
const Q1 = "00000000-0000-4000-8000-0000000000f1";
const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const COOKIE = `__Host-ductus_session=${TOKEN}`;

let running: Running | undefined;
const calls: unknown[][] = [];
let reply: () => Promise<unknown> = async () => undefined;
const refusal = (code: string) => Object.assign(new Error("refused"), { code });

async function start(): Promise<string> {
  const port = {
    exportOf: (...args: unknown[]) => (calls.push(["exportOf", ...args]), reply()),
  } as unknown as QuestionnaireExportPort;
  running = await startServer({
    host: "127.0.0.1",
    port: 0,
    databases: createDatabases(),
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: createQuestionnaireExportRoutes(port),
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

const EXPORT = {
  ok: true,
  export: {
    schema: "questionnaire-export-v1",
    questionnaireId: ID,
    variables: [
      {
        questionId: Q1,
        order: 1,
        kind: "single",
        label: "Kompostirate li?",
        options: [
          { code: "da", label: "Da" },
          { code: "ne", label: "Ne" },
        ],
      },
    ],
    rows: [1, 2, 3, 4, 5].map((n) => ({ n, values: { [Q1]: n === 5 ? null : "da" } })),
    responseCount: 5,
    includesText: false,
  },
};

describe("teacher questionnaire export", () => {
  it("returns the export as the store built it, without caching", async () => {
    const base = await start();
    reply = async () => EXPORT;
    const response = await get(base, `/teacher/questionnaires/${ID.toUpperCase()}/export`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual(EXPORT.export);
    expect(calls).toEqual([["exportOf", TOKEN, ID, false]]);
  });

  it("passes includeText=true and includeText=false exactly as asked", async () => {
    const base = await start();
    reply = async () => EXPORT;
    expect((await get(base, `/teacher/questionnaires/${ID}/export?includeText=true`)).status).toBe(
      200,
    );
    expect((await get(base, `/teacher/questionnaires/${ID}/export?includeText=false`)).status).toBe(
      200,
    );
    expect(calls).toEqual([
      ["exportOf", TOKEN, ID, true],
      ["exportOf", TOKEN, ID, false],
    ]);
  });

  it.each([
    "?includeText=da",
    "?includeText=",
    "?includeText=TRUE",
    "?includeText=true&includeText=false",
    "?includeText=true&extra=1",
    "?extra=1",
  ])("a query outside the contract (%s) is 422 and reaches no store", async (query) => {
    const base = await start();
    reply = async () => EXPORT;
    expect((await get(base, `/teacher/questionnaires/${ID}/export${query}`)).status).toBe(422);
    expect(calls).toEqual([]);
  });

  it("a malformed id is 404 and reaches no store", async () => {
    const base = await start();
    expect((await get(base, "/teacher/questionnaires/nije-uuid/export")).status).toBe(404);
    expect(calls).toEqual([]);
  });

  it("no session is 401 and reaches no store", async () => {
    const base = await start();
    expect((await get(base, `/teacher/questionnaires/${ID}/export`, null)).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("a cross-site read is refused before the store", async () => {
    const base = await start();
    const response = await fetch(`${base}/teacher/questionnaires/${ID}/export`, {
      headers: { "sec-fetch-site": "cross-site", cookie: COOKIE },
    });
    expect(response.status).toBe(403);
    expect(calls).toEqual([]);
  });

  it("fewer sheets than the least number is 409 and returns no export", async () => {
    const base = await start();
    reply = async () => ({ ok: false, reason: "too_few_responses" });
    const response = await get(base, `/teacher/questionnaires/${ID}/export`);
    expect(response.status).toBe(409);
    const text = await response.text();
    expect(text).not.toContain("rows");
    expect(text).not.toContain("variables");
  });

  it.each([
    ["ZD401", 401],
    ["ZD404", 404],
    ["ZD403", 404],
    ["ZD409", 409],
    ["ZD422", 422],
  ])("the database's %s reads as %i", async (code, status) => {
    const base = await start();
    reply = async () => {
      throw refusal(code);
    };
    expect((await get(base, `/teacher/questionnaires/${ID}/export`)).status).toBe(status);
  });

  it("a failure that is not a refusal is 503", async () => {
    const base = await start();
    reply = async () => {
      throw new Error("down");
    };
    expect((await get(base, `/teacher/questionnaires/${ID}/export`)).status).toBe(503);
  });

  it("an export that names a person next to a row is 503 and is not sent", async () => {
    const base = await start();
    reply = async () => ({
      ok: true,
      export: {
        ...EXPORT.export,
        rows: [{ n: 1, userId: ID, values: {} }, ...EXPORT.export.rows.slice(1)],
      },
    });
    const response = await get(base, `/teacher/questionnaires/${ID}/export`);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(ID);
  });

  it("an export with fewer than five sheets is 503, never sent", async () => {
    const base = await start();
    reply = async () => ({
      ok: true,
      export: { ...EXPORT.export, rows: EXPORT.export.rows.slice(0, 2), responseCount: 2 },
    });
    expect((await get(base, `/teacher/questionnaires/${ID}/export`)).status).toBe(503);
  });
});
