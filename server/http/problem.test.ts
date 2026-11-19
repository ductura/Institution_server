// S-1L.3 (DAN-789): every error the server answers is the problem body
// {code, messageKey, status, requestId} of a contract error, every key has a
// text in locales/hr.ts, and nothing else can be answered as an error.
import type { ServerResponse } from "node:http";

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { TObject, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import {
  type ErrorSpec,
  FALLBACK,
  INTERNAL,
  METHOD_NOT_ALLOWED,
  REQUEST_ID_PATTERN,
  ROUTES,
  SERVER_ERRORS,
  SHARED_ERRORS,
} from "../contracts/index.ts";
import { sendJson } from "./json.ts";
import {
  knownError,
  problemOf,
  sendBareRefusal,
  sendDeclaredResponse,
  sendProblem,
} from "./problem.ts";
import { requestIdOf } from "./request-id.ts";

const ID = "0f0e0d0c-0b0a-4908-8706-050403020100";
const UUID_V4 = new RegExp(REQUEST_ID_PATTERN, "u");

/** A response with only what problem.ts and request-id.ts touch. */
function fakeResponse() {
  const answer: { status?: number; headers: Record<string, string>; body?: string } = {
    headers: {},
  };
  const response = {
    headersSent: false,
    statusMessage: "",
    trailers: undefined as object | undefined,
    setHeader: (name: string, value: string) => (answer.headers[name.toLowerCase()] = value),
    getHeaderNames: () => Object.keys(answer.headers),
    removeHeader: (name: string) => delete answer.headers[name.toLowerCase()],
    addTrailers(trailers: object) {
      this.trailers = trailers;
    },
    writeHead(status: number, headers: Record<string, string>) {
      answer.status = status;
      Object.assign(answer.headers, headers);
      this.headersSent = true;
    },
    end: (body: string) => (answer.body = body),
  };
  return { response: response as unknown as ServerResponse, answer };
}

// The table, the texts in hr and en and option (c) in the contract are
// tested in server/contracts/message-keys.test.ts (DAN-789 a).

// Bodies that keep a v1 shape the guard does not let change (PR opis, "Poznate
// granice"): a page for a browser navigation, no body, or the code in `status`.
// Errors under a oneOf have the problem body since DAN-791. A closed list, so a
// new route with another shape fails here.
const HTML = new Set([
  "auth.login.get",
  "auth.callback.get",
  "auth.logout.post",
  "auth.logout-all.post",
]);
const NO_BODY = new Set([
  "auth.backchannel-logout.post 400",
  "platform.status.get 503",
  "auth.backchannel-logout.post 503",
]);
const CODE_IN_STATUS = new Set([
  "platform.ready.get",
  "evidence.open.post",
  "evidence.commit.post",
  "submission.submit.post",
  "evidence.replay.post",
]);

function properties(schema: TSchema): Record<string, TSchema> {
  return (schema as TObject).properties;
}

describe("every route in the inventory", () => {
  const cases = ROUTES.flatMap((route) =>
    route.errors.map((spec) => [route.id, spec.status, spec.code, spec] as const),
  );

  it.each(cases)("%s %i %s has the problem fields", (id, status, code, spec: ErrorSpec) => {
    if (spec.body === "html") return expect(HTML.has(id)).toBe(true);
    if (spec.body === "none") return expect(NO_BODY.has(`${id} ${status}`)).toBe(true);
    expect(spec.body).toBeTypeOf("object");
    const props = properties(spec.body as TSchema);
    if (CODE_IN_STATUS.has(id)) {
      // The v1 body as it was: the code in `status`, no problem field.
      expect(props["status"]).toMatchObject({ const: code });
      return expect(Object.keys(props)).not.toContain("messageKey");
    }
    expect(props["code"]).toMatchObject({ const: code });
    expect(props["messageKey"]).toMatchObject({ const: spec.key });
    expect(props["status"]).toMatchObject({ const: status });
    expect(props["requestId"]).toMatchObject({ type: "string", pattern: REQUEST_ID_PATTERN });
    // The answer problem.ts gives is valid against the route's own schema.
    expect(Value.Check(spec.body as TSchema, problemOf(status, code, ID))).toBe(true);
  });

  it("the shared errors, the fallback and 405 have the default problem body", () => {
    for (const spec of [...SHARED_ERRORS, FALLBACK.error, METHOD_NOT_ALLOWED.error]) {
      expect(Value.Check(spec.body as TSchema, problemOf(spec.status, spec.code, ID))).toBe(true);
    }
  });
});

describe("problemOf and sendProblem", () => {
  it("answer exactly the five fields of a contract error", () => {
    expect(problemOf(404, "not_found", ID)).toEqual({
      error: "not_found",
      code: "not_found",
      messageKey: "errors.notFound",
      status: 404,
      requestId: ID,
    });
  });

  it.each([
    [404, "made_up_code"],
    [418, "not_found"],
    [200, "internal"],
    [404, "__proto__"],
    [404, "toString"],
    [Number.NaN, "not_found"],
  ])("answer 500 internal for %s %j, which no contract has", (status, code) => {
    expect(knownError(status, code)).toBeUndefined();
    expect(problemOf(status, code, ID)).toEqual(problemOf(500, "internal", ID));
  });

  it("take the key and status from the contract, never from the caller", () => {
    for (const spec of SERVER_ERRORS) {
      const body = problemOf(spec.status, spec.code, ID);
      expect([body.messageKey, body.status]).toEqual([spec.key, spec.status]);
    }
  });

  it("write the body, the status and the same id as X-Request-Id", () => {
    const { response, answer } = fakeResponse();
    sendProblem(response, 405, "method_not_allowed", { allow: "GET" });
    const body = JSON.parse(answer.body ?? "") as { requestId: string };
    expect(answer.status).toBe(405);
    expect(body.requestId).toMatch(UUID_V4);
    expect(answer.headers["x-request-id"]).toBe(body.requestId);
    expect(answer.headers["allow"]).toBe("GET");
    expect(Object.keys(body)).toEqual(["error", "code", "messageKey", "status", "requestId"]);
  });

  // DAN-791: an error under a oneOf (403 of the mutation guard) has the full
  // problem body too, and its request id is the one in X-Request-Id.
  it("write the problem body for an error under a oneOf, the id equal to X-Request-Id", () => {
    const { response, answer } = fakeResponse();
    sendProblem(response, 403, "origin_missing");
    expect(answer.status).toBe(403);
    const id = answer.headers["x-request-id"];
    expect(id).toMatch(UUID_V4);
    expect(JSON.parse(answer.body ?? "")).toEqual({
      error: "origin_missing",
      code: "origin_missing",
      messageKey: "errors.originMissing",
      status: 403,
      requestId: id,
    });
  });

  it("drop what was set before but the security headers, Connection and Retry-After", () => {
    const { response, answer } = fakeResponse();
    for (const [name, value] of [
      ["Content-Length", "3"],
      ["Content-Encoding", "gzip"],
      ["Set-Cookie", "s=1"],
      ["Location", "https://x.invalid/"],
      ["Trailer", "x-t"],
      ["X-Frame-Options", "DENY"],
      ["Connection", "close"],
      ["Retry-After", "1"],
    ] as const)
      response.setHeader(name, value);
    response.addTrailers({ "x-t": "1" });
    response.statusMessage = "db down";
    sendProblem(response, 404, "not_found");
    const body = answer.body ?? "";
    expect(answer.headers).toEqual({
      "x-frame-options": "DENY",
      connection: "close",
      "retry-after": "1",
      "x-request-id": expect.stringMatching(UUID_V4),
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": String(Buffer.byteLength(body)),
    });
    expect([
      response.statusMessage,
      (response as unknown as { trailers: object }).trailers,
    ]).toEqual(["Not Found", {}]);
  });

  it.each(["X-Request-Id", "x-request-id", "Content-Type", "cache-control"])(
    "a caller cannot replace %s",
    (name) => {
      const { response, answer } = fakeResponse();
      const headers = { [name]: "11111111-1111-4111-8111-111111111111" };
      expect(() => sendJson(response, 200, {}, headers)).toThrow(/set by writeJson/u);
      // sendProblem takes only `allow`; anything else is not passed on.
      sendProblem(response, 404, "not_found", headers as { allow?: string });
      expect(answer.headers[name.toLowerCase()]).not.toBe("11111111-1111-4111-8111-111111111111");
    },
  );

  it("an unknown pair is answered as 500, not with the caller's status", () => {
    const { response, answer } = fakeResponse();
    sendProblem(response, 404, "made_up_code");
    expect(answer.status).toBe(INTERNAL.error.status);
  });
});

describe("requestIdOf", () => {
  it("is one UUID v4 per response, the same on every call", () => {
    const [a, b] = [fakeResponse(), fakeResponse()];
    const first = requestIdOf(a.response);
    expect(first).toMatch(UUID_V4);
    expect(requestIdOf(a.response)).toBe(first);
    expect(requestIdOf(b.response)).not.toBe(first);
  });
});

describe("sendJson", () => {
  it.each([400, 404, 500, 599, 1000, Number.NaN, 200.5, 0, 101, 199, 204, 205, 301, 399])(
    "refuses status %s: an error goes through sendProblem",
    (status) => {
      const { response, answer } = fakeResponse();
      expect(() => sendJson(response, status, { error: "x" })).toThrow(/sendProblem/u);
      expect(answer.status).toBeUndefined();
    },
  );
});

// Only these files write JSON with writeJson: sendJson and sendProblem.
const WRITERS = ["server/http/json.ts", "server/http/problem.ts"];
// The transitional HTTP server is a smoke test only (docs/server-map.md, "Prelazno stanje").
const LEGACY = ["server/app.ts"];

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "generated" ? [] : sources(path);
    return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("server code", () => {
  // fileURLToPath: a URL's pathname keeps %20 and gives /D:/ on Windows;
  // relative() uses \ there, so the paths are compared with /.
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const files = sources(join(root, "server")).map((path) =>
    relative(root, path).split(sep).join("/"),
  );

  it("writes JSON with writeJson only in the two writers", () => {
    const using = files.filter((file) =>
      /\bwriteJson\s*\(/u.test(readFileSync(join(root, file), "utf8")),
    );
    expect(using.sort()).toEqual([...WRITERS].sort());
  });

  it("never spells the old error body {error: ...} where it answers HTTP", () => {
    const old = files.filter((file) => {
      const text = readFileSync(join(root, file), "utf8");
      return (
        !LEGACY.includes(file) &&
        /["']node:http["']/u.test(text) &&
        /[{,]\s*error:\s*["'`]/u.test(text)
      );
    });
    expect(old).toEqual([]);
  });
});

describe("sendBareRefusal", () => {
  const route = (id: string) => ROUTES.find((r) => r.id === id)!;

  it.each([...NO_BODY])("answers %s with no body and no-store", (entry) => {
    const [id, status] = entry.split(" ");
    const { response, answer } = fakeResponse();
    sendBareRefusal(response, route(id!), Number(status));
    expect(answer.status).toBe(Number(status));
    expect(answer.headers["cache-control"]).toBe("no-store");
    expect(answer.body).toBeUndefined();
  });

  it.each([
    ["auth.backchannel-logout.post", 404],
    ["auth.logout.post", 403],
    ["evidence.open.post", 401],
  ])("answers 500 internal for %s %s, which has no bare error", (id, status) => {
    const { response, answer } = fakeResponse();
    sendBareRefusal(response, route(id), status);
    expect(answer.status).toBe(500);
    expect(JSON.parse(answer.body ?? "{}")).toMatchObject({ code: INTERNAL.error.code });
  });
});

describe("sendDeclaredResponse", () => {
  const put = ROUTES.find((r) => r.id === "live.document.put")!;
  const TOKEN = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";

  it("answers a response of 400 or more the contract declares, with its body", () => {
    for (const token of [TOKEN, null]) {
      const { response, answer } = fakeResponse();
      response.setHeader("etag", '"x"');
      sendDeclaredResponse(response, put, 409, { outcome: "conflict", token });
      expect(answer.status).toBe(409);
      expect(JSON.parse(answer.body!)).toEqual({ outcome: "conflict", token });
      expect(answer.headers["cache-control"]).toBe("no-store");
      expect(answer.headers.etag).toBeUndefined();
    }
  });

  it.each<[string, number, Record<string, unknown>]>([
    ["a body the schema refuses", 409, { outcome: "conflict", token: "nije-uuid" }],
    ["an extra field", 409, { outcome: "conflict", token: TOKEN, revision: 1 }],
    ["a status the contract does not declare", 410, { outcome: "conflict", token: TOKEN }],
    ["a success status", 200, { outcome: "accepted", token: TOKEN }],
  ])("answers 500 internal for %s", (_name, status, body) => {
    const { response, answer } = fakeResponse();
    sendDeclaredResponse(response, put, status, body);
    expect(answer.status).toBe(500);
    expect(JSON.parse(answer.body ?? "{}")).toMatchObject({ code: INTERNAL.error.code });
  });
});
