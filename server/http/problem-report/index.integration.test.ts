import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ActorTransaction, WithActor } from "../../database/index.ts";
import { createDatabases, createLayers, startServer, type Running } from "../index.ts";

import { createProblemReportsRouteFor } from "./index.ts";

const ORIGIN = "https://ductura.example.invalid";
const TOKEN = "Izmisljeni_token-prijave-problema_000000002";
const REPORT = { category: "technical", description: "Izmišljeni opis.", appVersion: "1.4.0" };
const query = vi.fn<(sql: string, values?: readonly unknown[]) => Promise<unknown>>();
const withActor: WithActor = (token, run) => {
  expect(token).toBe(TOKEN);
  return run({ query } as unknown as ActorTransaction);
};

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    databases: createDatabases(),
    routes: [createProblemReportsRouteFor({ withActor })],
  });
});
afterAll(async () => server?.close());
beforeEach(() => query.mockReset());

function send(body: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${server.port}/api/v1/problem-reports`, {
    method: "POST",
    headers: {
      origin: ORIGIN,
      "sec-fetch-site": "same-origin",
      "content-type": "application/json",
      cookie: `__Host-ductus_session=${TOKEN}`,
      ...headers,
    },
    body,
  });
}

describe("POST /api/v1/problem-reports", () => {
  it("passes just the report to the shared RPC and returns only its reference", async () => {
    query.mockResolvedValueOnce({ rows: [{ reference: "PR-AABBCCDDEE" }] });
    query.mockResolvedValueOnce({ rows: [{ touched: true }] });
    const description = "🧪".repeat(2000);
    const answer = await send(JSON.stringify({ ...REPORT, description }));
    expect(answer.status).toBe(201);
    expect(await answer.json()).toEqual({ reference: "PR-AABBCCDDEE" });
    expect(query.mock.calls[0]).toEqual([
      expect.stringContaining("identity.submit_problem_report("),
      ["technical", description, null, "1.4.0", "other", null, null],
    ]);
  });

  it.each([
    ["category", { ...REPORT, category: "wrong" }],
    ["version", { ...REPORT, appVersion: "1.2.3\n" }],
    ["missing version", { ...REPORT, appVersion: undefined }],
    ["empty text", { ...REPORT, description: "" }],
    ["blank text", { ...REPORT, description: " \u200b\n" }],
    ["control character", { ...REPORT, description: "a\u0000b" }],
    ["bidi override", { ...REPORT, description: "a\u202eb" }],
    ["lone surrogate", { ...REPORT, description: "\ud800" }],
    ["over 2000 code points", { ...REPORT, description: "🧪".repeat(2001) }],
    ["account override", { ...REPORT, userId: "demo-student" }],
    ["screenshot", { ...REPORT, screenshot: "demo-image" }],
    ["document content", { ...REPORT, work: "Izmišljeni rad" }],
  ])("refuses invalid %s before any database call", async (_name, body) => {
    const answer = await send(JSON.stringify(body));
    expect(answer.status).toBe(422);
    expect(await answer.json()).toMatchObject({ code: "invalid_input" });
    expect(query).not.toHaveBeenCalled();
  });

  it.each([
    [400, "invalid_json", "{", {}],
    [401, "unauthorized", JSON.stringify(REPORT), { cookie: "" }],
    [403, "origin_mismatch", JSON.stringify(REPORT), { origin: "https://other.invalid" }],
    [415, "unsupported_media_type", JSON.stringify(REPORT), { "content-type": "text/plain" }],
  ] as const)(
    "refuses with %i %s before any database call",
    async (status, code, body, headers) => {
      const answer = await send(body, headers);
      expect(answer.status).toBe(status);
      expect(await answer.json()).toMatchObject({ code });
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["ZD401", 401, "unauthorized"],
    ["ZD422", 422, "invalid_input"],
    ["ZD429", 429, "too_many_reports"],
  ])("maps database refusal %s to %i without recording activity", async (code, status, reason) => {
    query.mockRejectedValueOnce(Object.assign(new Error("Izmišljena greška."), { code }));
    const answer = await send(JSON.stringify(REPORT));
    expect(answer.status).toBe(status);
    expect(await answer.json()).toMatchObject({ code: reason });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
