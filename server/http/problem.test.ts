// S-1L.3 (DAN-789): every error the server answers is the problem body
// {code, messageKey, status, requestId} of a contract error, every key has a
// text in locales/hr.ts, and nothing else can be answered as an error.
import type { ServerResponse } from "node:http";

import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";

import type { TObject, TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { messagesEn, messagesHr, textOf, type MessageKey } from "../../locales/index.ts";
import {
  error,
  ERROR_MESSAGE_KEYS,
  type ErrorSpec,
  FALLBACK,
  INTERNAL,
  METHOD_NOT_ALLOWED,
  REQUEST_ID_PATTERN,
  ROUTES,
  SERVER_ERRORS,
  SHARED_ERRORS,
  v1Error,
} from "../contracts/index.ts";
import { sendJson } from "./json.ts";
import { knownError, problemOf, sendProblem } from "./problem.ts";
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
    setHeader: (name: string, value: string) => (answer.headers[name.toLowerCase()] = value),
    writeHead(status: number, headers: Record<string, string>) {
      answer.status = status;
      Object.assign(answer.headers, headers);
      this.headersSent = true;
    },
    end: (body: string) => (answer.body = body),
  };
  return { response: response as unknown as ServerResponse, answer };
}

const camel = (code: string) =>
  code.replace(/_([a-z])/gu, (_, letter: string) => letter.toUpperCase());

describe("every messageKey of the server", () => {
  it("is in the registry, with the key of its code in ERROR_MESSAGE_KEYS", () => {
    expect(SERVER_ERRORS).toEqual(
      expect.arrayContaining([...SHARED_ERRORS, FALLBACK.error, METHOD_NOT_ALLOWED.error]),
    );
    for (const route of ROUTES)
      expect(SERVER_ERRORS).toEqual(expect.arrayContaining([...route.errors]));
    for (const spec of SERVER_ERRORS) expect(spec.key).toBe(ERROR_MESSAGE_KEYS.get(spec.code));
  });

  it("ERROR_MESSAGE_KEYS maps each snake_case code to errors.<camelCase>, and every row is used", () => {
    const used = new Set(SERVER_ERRORS.map((spec) => spec.code));
    for (const [code, key] of ERROR_MESSAGE_KEYS) {
      expect(code).toMatch(/^[a-z]+(?:_[a-z]+)*$/u);
      expect(key).toBe(`errors.${camel(code)}`);
      expect(used.has(code)).toBe(true);
    }
    expect(new Set(ERROR_MESSAGE_KEYS.values()).size).toBe(ERROR_MESSAGE_KEYS.size);
  });

  it("a code without a row cannot be declared", () => {
    expect(() => error(404, "made_up_code")).toThrow(/no message key/u);
    expect(() => v1Error(400, "__proto__")).toThrow(/no message key/u);
  });

  it("each status and code is answered in one shape: v1 or the problem body", () => {
    const v1 = new Set(SERVER_ERRORS.filter((spec) => spec.v1).map((s) => `${s.status} ${s.code}`));
    const problem = SERVER_ERRORS.filter(
      (spec) => !spec.v1 && typeof spec.body === "object" && "messageKey" in properties(spec.body),
    ).map((spec) => `${spec.status} ${spec.code}`);
    expect(problem.filter((pair) => v1.has(pair))).toEqual([]);
  });

  it.each(SERVER_ERRORS.map((spec) => [spec.key, spec.status] as const))(
    "%s (%i) has a text in hr and en",
    (key) => {
      expect(textOf(messagesHr, key as MessageKey)).toEqual(expect.stringMatching(/\S/u));
      expect(textOf(messagesEn, key as MessageKey)).toEqual(expect.stringMatching(/\S/u));
    },
  );

  it("has no text in errors that no error uses", () => {
    const used = new Set(SERVER_ERRORS.map((spec) => spec.key));
    for (const table of [messagesHr, messagesEn])
      expect(Object.keys(table.errors).filter((name) => !used.has(`errors.${name}`))).toEqual([]);
  });

  it("an unknown key fails the check above", () => {
    expect(() => textOf(messagesHr, "errors.madeUpCode" as MessageKey)).toThrow();
    expect(() => textOf(messagesHr, "errors.not_found" as MessageKey)).toThrow();
  });
});

// Bodies that keep a v1 shape the guard does not let change (PR opis, "Poznate
// granice"): a page for a browser navigation, no body, the code in `status`, or
// {error: code} under a oneOf (v1Error). A closed list, so a new route with
// another shape fails here.
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
]);
const V1_ONE_OF = new Set([
  "profile.interface-locale.post 400",
  "profile.interface-locale.post 403",
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
    if (spec.v1 === true) {
      expect(V1_ONE_OF.has(`${id} ${status}`)).toBe(true);
      return expect(Object.keys(props)).toEqual(["error"]);
    }
    expect(props["code"]).toMatchObject({ const: code });
    expect(props["messageKey"]).toMatchObject({ const: spec.key });
    expect(props["status"]).toMatchObject({ const: status });
    expect(props["requestId"]).toMatchObject({ type: "string", pattern: REQUEST_ID_PATTERN });
    // The answer problem.ts gives is valid against the route's own schema.
    expect(Value.Check(spec.body as TSchema, problemOf(status, code, ID))).toBe(true);
  });

  // Option (c) of DAN-789: a field added under a oneOf breaks v1 (breaking.ts),
  // so no status with several JSON errors may carry the problem fields.
  it("has no problem body under a oneOf (a status with several JSON errors)", () => {
    for (const route of ROUTES) {
      const json = route.errors.filter((spec) => typeof spec.body === "object");
      for (const spec of json) {
        if (json.filter((other) => other.status === spec.status).length < 2) continue;
        const where = `${route.id} ${spec.status} ${spec.code}`;
        expect(Object.keys(properties(spec.body as TSchema)), where).not.toContain("messageKey");
      }
    }
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

  it("write {error: code} for an error marked v1, with the request id only in X-Request-Id", () => {
    const { response, answer } = fakeResponse();
    sendProblem(response, 403, "origin_missing");
    expect(answer.status).toBe(403);
    expect(JSON.parse(answer.body ?? "")).toEqual({ error: "origin_missing" });
    expect(answer.headers["x-request-id"]).toMatch(UUID_V4);
  });

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
  it.each([400, 404, 500, 599, 1000, Number.NaN, 200.5])(
    "refuses status %s: an error goes through sendProblem",
    (status) => {
      const { response, answer } = fakeResponse();
      expect(() => sendJson(response, status, { error: "x" })).toThrow(/sendProblem/u);
      expect(answer.status).toBeUndefined();
    },
  );
});

// Only these files write JSON with writeJson: sendJson, sendProblem and the
// refusal while draining, which sends a problemFor body.
const WRITERS = ["server/http/json.ts", "server/http/problem.ts", "server/http/start.ts"];
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
  const root = new URL("../../", import.meta.url).pathname;
  const files = sources(join(root, "server")).map((path) => relative(root, path));

  it("writes JSON with writeJson only in the three writers", () => {
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
