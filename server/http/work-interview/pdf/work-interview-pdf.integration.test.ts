import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../../index.ts";

import { createWorkInterviewPdfRouteFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "t".repeat(43);
const PATH = "/api/v1/works/doc-izmisljeni/interview/pdf";
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
    routes: [createWorkInterviewPdfRouteFor({ withActor })],
  });
});
afterAll(async () => server.close());
beforeEach(() => query.mockReset());

const get = (token?: string, headers: Record<string, string> = {}) =>
  fetch(`http://127.0.0.1:${server.port}${PATH}`, {
    headers: {
      ...(token === undefined ? {} : { cookie: `__Host-ductus_session=${token}` }),
      ...headers,
    },
  });

const invited = {
  invitedAt: "2026-11-24T10:00:00+01:00",
  questions: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      paragraphRef: null,
      questionText: "Kako je nastao rad?",
      createdAt: "2026-11-24T10:00:00+01:00",
      mine: true,
    },
  ],
  explanations: [],
  appointment: null,
  heldOn: null,
};

describe("work interview PDF", () => {
  it("answers a PDF of the invited preparation", async () => {
    query.mockReturnValueOnce([{ result: invited }]);
    const response = await get(TOKEN);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { filename: string; pdfBase64: string };
    expect(body.filename).toBe("priprema-za-razgovor.pdf");
    expect(Buffer.from(body.pdfBase64, "base64").subarray(0, 5).toString()).toBe("%PDF-");
  });

  it("shares nothing before the invitation: 409", async () => {
    query.mockReturnValueOnce([{ result: { ...invited, invitedAt: null } }]);
    expect((await get(TOKEN)).status).toBe(409);
  });

  it("refuses without a session, cross-site, and when the database refuses", async () => {
    expect((await get()).status).toBe(401);
    expect((await get(TOKEN, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    query.mockImplementationOnce(() => {
      throw Object.assign(new Error("x"), { code: "ZD403" });
    });
    expect((await get(TOKEN)).status).toBe(403);
    query.mockImplementationOnce(() => {
      throw new Error("db down");
    });
    expect((await get(TOKEN)).status).toBe(503);
  });
});
