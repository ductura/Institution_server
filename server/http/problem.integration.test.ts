// S-1L.3 (DAN-789) on a real server: every refusal is a problem body with an
// id the server made, the client cannot choose it, and a failing handler gives
// nothing of its error (message, stack, SQL) but the problem of 500 internal.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { REQUEST_ID_PATTERN, ROUTES } from "../contracts/index.ts";
import { createDatabases } from "./databases.ts";
import { HEALTH_ROUTE } from "./health.ts";
import { createLayers } from "./pipeline.ts";
import type { Route } from "./router.ts";
import { type Running, startServer } from "./start.ts";

const ORIGIN = "https://ductura.invalid";
const CANARY = "made-up-canary-5c1d";
const FORGED = "11111111-1111-4111-8111-111111111111";
const UUID_V4 = new RegExp(REQUEST_ID_PATTERN, "u");

const ready = ROUTES.find((route) => route.id === "platform.ready.get");
if (ready === undefined) throw new Error("no contract");
// A handler that fails the way a database call would: SQL and a stack in the error.
const failing: Route = {
  contract: ready,
  handle: async () => {
    const failure = new Error(`syntax error at or near "${CANARY}"`);
    failure.stack = `error: select * from ${CANARY}\n    at /srv/${CANARY}.ts:1:1`;
    Object.assign(failure, { query: `select '${CANARY}'`, detail: CANARY, code: "42601" });
    throw failure;
  },
};

let server: Running;
beforeAll(async () => {
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: ORIGIN }),
    routes: [HEALTH_ROUTE, failing],
    databases: createDatabases(),
  });
});
afterAll(() => server.close());

const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;

async function refusal(path: string, init: RequestInit = {}) {
  const response = await fetch(url(path), init);
  const text = await response.text();
  return { response, text, body: JSON.parse(text) as Record<string, unknown> };
}

describe("problem bodies on the wire", () => {
  it.each([
    ["404", "/api/v1/nope", {}, 404, "not_found"],
    [
      "405",
      "/api/v1/health",
      { method: "DELETE", headers: { origin: ORIGIN } },
      405,
      "method_not_allowed",
    ],
    ["403", "/api/v1/health", { method: "POST" }, 403, "origin_missing"],
  ] as const)(
    "%s has exactly the four fields and v1's error",
    async (_, path, init, status, code) => {
      const { response, body } = await refusal(path, init);
      expect(response.status).toBe(status);
      expect(Object.keys(body).sort()).toEqual([
        "code",
        "error",
        "messageKey",
        "requestId",
        "status",
      ]);
      expect(body).toMatchObject({ code, error: code, messageKey: `errors.${code}`, status });
      expect(body["requestId"]).toMatch(UUID_V4);
      expect(response.headers.get("x-request-id")).toBe(body["requestId"]);
    },
  );

  it("never takes the request id from the client", async () => {
    const forged = { "x-request-id": FORGED, "request-id": FORGED, "x-correlation-id": FORGED };
    const { response, text, body } = await refusal(`/api/v1/nope?requestId=${FORGED}`, {
      headers: forged,
    });
    expect(text).not.toContain(FORGED);
    expect(body["requestId"]).toMatch(UUID_V4);
    expect(response.headers.get("x-request-id")).toBe(body["requestId"]);
  });

  it("gives each request an id of its own", async () => {
    const ids = await Promise.all(
      Array.from({ length: 20 }, async () => (await refusal("/api/v1/nope")).body["requestId"]),
    );
    expect(new Set(ids).size).toBe(20);
  });

  it("a failing handler: 500 internal, no message, stack or SQL, the id in the log", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const { response, text, body } = await refusal("/api/v1/ready");
      expect(response.status).toBe(500);
      expect(body).toEqual({
        error: "internal",
        code: "internal",
        messageKey: "errors.internal",
        status: 500,
        requestId: response.headers.get("x-request-id"),
      });
      for (const leak of [CANARY, "select", "syntax", "42601", "/srv/", "at "]) {
        expect(text).not.toContain(leak);
      }
      const logged = JSON.stringify(log.mock.calls);
      expect(logged).not.toContain(CANARY);
      expect(logged).toContain(String(body["requestId"]));
    } finally {
      log.mockRestore();
    }
  });

  it("a success answer is unchanged: no request id", async () => {
    const response = await fetch(url("/api/v1/health"));
    expect(await response.json()).toEqual({ status: "ok" });
    expect(response.headers.get("x-request-id")).toBeNull();
  });
});
