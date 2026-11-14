import { describe, expect, it } from "vitest";

import { openapiDocument } from "../../scripts/generate-contracts.ts";
import { breakingChanges } from "./breaking.ts";

type Obj = Record<string, unknown>;

/** The object under a chain of keys; a missing one fails the test instead of passing quietly. */
function node(value: unknown, ...keys: string[]): Obj {
  const found = keys.reduce<unknown>((v, k) => (v as Obj | undefined)?.[k], value);
  if (typeof found !== "object" || found === null || Array.isArray(found)) throw new Error(`no object at ${keys.join(".")}`);
  return found as Obj;
}

function list(value: unknown, ...keys: string[]): unknown[] {
  const found = keys.reduce<unknown>((v, k) => (v as Obj | undefined)?.[k], value);
  if (!Array.isArray(found)) throw new Error(`no array at ${keys.join(".")}`);
  return found;
}

// Every case starts from the real v1 document, changes one thing and raises the
// minor version, so only the change itself can be reported.
function changed(edit: (doc: Obj) => void, version = "1.1.0"): Obj {
  const doc = structuredClone(openapiDocument()) as Obj;
  node(doc, "info").version = version;
  edit(doc);
  return doc;
}

const HEALTH = "/api/v1/health";
const LOCALE = "/api/v1/profile/interface-locale";
const STATUS = "/api/v1/status";
const LOGIN = "/api/v1/auth/login";
const BACKCHANNEL = "/api/v1/auth/backchannel-logout";
const JSON_TYPE = "application/json";

const paths = (d: Obj) => node(d, "paths");
const op = (d: Obj, path: string, method = "get") => node(d, "paths", path, method);
const responses = (d: Obj, path: string) => node(op(d, path), "responses");
const ok = (d: Obj, path: string) => node(responses(d, path), "200", "content", JSON_TYPE, "schema");
const okProps = (d: Obj, path: string) => node(ok(d, path), "properties");
const localeBody = (d: Obj) => node(op(d, LOCALE, "post"), "requestBody", "content", JSON_TYPE, "schema");
const loginQuery = (d: Obj) => list(op(d, LOGIN), "parameters");
const returnTo = (d: Obj) => node(loginQuery(d), "0");
const formBody = (d: Obj) => node(op(d, BACKCHANNEL, "post"), "requestBody", "content", "application/x-www-form-urlencoded", "schema");
const token = (d: Obj) => node(formBody(d), "properties", "logout_token");
const limit = (d: Obj, by: number) => {
  const post = op(d, LOCALE, "post");
  post["x-max-body-bytes"] = (post["x-max-body-bytes"] as number) + by;
};
const addRoute = (d: Obj) => (paths(d)["/api/v1/made-up"] = structuredClone(paths(d)[HEALTH]));
const str = { type: "string" };
const de = { const: "de", type: "string" };

// [class, edit, expected problems]; an empty list means the change does not break clients.
const CASES: [string, (d: Obj) => void, string[]][] = [
  // Routes
  ["route removed", (d) => delete paths(d)[HEALTH], [`GET ${HEALTH}: route removed`]],
  ["method removed", (d) => delete node(paths(d), LOCALE).post, [`POST ${LOCALE}: route removed`]],
  ["operationId changed", (d) => (op(d, HEALTH).operationId = "platform.alive.get"), [`GET ${HEALTH}: operationId changed`]],
  ["access changed", (d) => (op(d, HEALTH)["x-access"] = "signed_in"), [`GET ${HEALTH}: access changed`]],
  ["new route", addRoute, []],
  ["new method on a path", (d) => (node(paths(d), HEALTH).post = structuredClone(op(d, HEALTH))), []],
  // Parameters
  ["parameter removed", (d) => loginQuery(d).pop(), [`GET ${LOGIN}: parameter query:returnTo removed`]],
  ["parameter became required", (d) => (returnTo(d).required = true), [`GET ${LOGIN}: parameter query:returnTo became required`]],
  ["new required parameter", (d) => loginQuery(d).push({ name: "x", in: "query", required: true, schema: str }), [`GET ${LOGIN}: new required parameter query:x`]],
  ["new optional parameter", (d) => loginQuery(d).push({ name: "x", in: "query", required: false, schema: str }), []],
  ["parameter type changed", (d) => (returnTo(d).schema = { type: "number" }), [`GET ${LOGIN} parameter query:returnTo: type changed from string to number`]],
  // Request body
  ["request body added", (d) => (op(d, HEALTH).requestBody = { required: true, content: { [JSON_TYPE]: { schema: { type: "object" } } } }), [`GET ${HEALTH}: request body added`]],
  ["request body removed", (d) => delete op(d, LOCALE, "post").requestBody, [`POST ${LOCALE}: request body removed`]],
  [
    "content type removed",
    (d) => {
      const c = node(op(d, LOCALE, "post"), "requestBody", "content");
      c["text/plain"] = c[JSON_TYPE];
      delete c[JSON_TYPE];
    },
    [`POST ${LOCALE}: content type application/json removed`],
  ],
  ["body limit lowered", (d) => limit(d, -1), [`POST ${LOCALE}: body limit lowered`]],
  ["body limit raised", (d) => limit(d, 1), []],
  [
    "new required request field",
    (d) => {
      node(localeBody(d), "properties").theme = str;
      list(localeBody(d), "required").push("theme");
    },
    [`POST ${LOCALE} body.theme: field became required`],
  ],
  ["new optional field in a closed request", (d) => (node(localeBody(d), "properties").theme = str), []],
  [
    "field no longer accepted in a closed request",
    (d) => {
      delete node(localeBody(d), "properties").locale;
      localeBody(d).required = [];
    },
    [`POST ${LOCALE} body.locale: field no longer accepted`],
  ],
  [
    "field removed from an open request",
    (d) => {
      delete node(formBody(d), "properties").logout_token;
      formBody(d).required = [];
    },
    [],
  ],
  ["request closed to extra fields", (d) => (formBody(d).additionalProperties = false), [`POST ${BACKCHANNEL} body: extra fields no longer accepted`]],
  ["request minLength raised", (d) => (token(d).minLength = 2), [`POST ${BACKCHANNEL} body.logout_token: minLength raised`]],
  ["request maxLength added", (d) => (token(d).maxLength = 10), [`POST ${BACKCHANNEL} body.logout_token: maxLength lowered`]],
  ["request format added", (d) => (token(d).format = "uuid"), [`POST ${BACKCHANNEL} body.logout_token: format changed`]],
  ["request minLength lowered", (d) => (token(d).minLength = 0), []],
  ["request accepts a new value", (d) => list(localeBody(d), "properties", "locale", "anyOf").push(de), []],
  ["request no longer accepts a value", (d) => list(localeBody(d), "properties", "locale", "anyOf").pop(), [`POST ${LOCALE} body.locale: no longer accepted {"const":"en","type":"string"}`]],
  // Success responses
  ["success status removed", (d) => delete responses(d, HEALTH)["200"], [`GET ${HEALTH}: response 200 removed`]],
  ["success body removed", (d) => delete node(responses(d, HEALTH), "200").content, [`GET ${HEALTH}: response 200 body removed`]],
  [
    "response field removed",
    (d) => {
      delete okProps(d, HEALTH).status;
      ok(d, HEALTH).required = [];
    },
    [`GET ${HEALTH} response 200.status: field removed`],
  ],
  ["response field became optional", (d) => (ok(d, HEALTH).required = []), [`GET ${HEALTH} response 200.status: field became optional`]],
  ["response type changed", (d) => (okProps(d, STATUS).checkedAt = { type: "number" }), [`GET ${STATUS} response 200.checkedAt: type changed from string to number`]],
  ["response const changed", (d) => (node(okProps(d, HEALTH), "status").const = "alive"), [`GET ${HEALTH} response 200.status: value changed`]],
  ["new value in a response", (d) => list(okProps(d, LOCALE), "locale", "anyOf").push(de), [`GET ${LOCALE} response 200.locale: new in response {"const":"de","type":"string"}`]],
  ["response header removed", (d) => (node(responses(d, LOGIN), "303").headers = {}), [`GET ${LOGIN}: response 303 header location removed`, `GET ${LOGIN}: response 303 header set-cookie removed`]],
  ["new optional response field", (d) => (okProps(d, HEALTH).uptime = { type: "number" }), []],
  ["new success status", (d) => (responses(d, HEALTH)["204"] = { description: "x" }), []],
  ["response maxLength changed", (d) => (node(okProps(d, STATUS), "checkedAt").maxLength = 30), []],
  // Errors
  ["new error code on an existing status", (d) => (node(responses(d, LOCALE), "403").description = "forbidden, made_up"), []],
  ["error status removed", (d) => delete responses(d, LOCALE)["503"], []],
];

describe("breaking changes", () => {
  it("an unchanged document with the same version breaks nothing", () => {
    expect(breakingChanges(openapiDocument(), openapiDocument())).toEqual([]);
  });

  it.each(CASES)("%s", (_, edit, expected) => {
    expect(breakingChanges(openapiDocument(), changed(edit))).toEqual(expected);
  });
});

describe("version field", () => {
  it.each([
    ["changed document, same version", "1.0.0", ["info.version: the document changed but the version did not rise above 1.0.0"]],
    ["changed document, patch raised", "1.0.1", []],
    ["changed document, minor raised", "1.1.0", []],
    ["version lowered", "0.9.0", ["info.version: major changed from 1 to 0; a new major is a new document", "info.version: lowered from 1.0.0 to 0.9.0"]],
    ["new major in the v1 document", "2.0.0", ["info.version: major changed from 1 to 2; a new major is a new document"]],
    ["not major.minor.patch", "1.1", ["info.version: 1.1 is not major.minor.patch"]],
  ])("%s", (_, version, expected) => {
    expect(breakingChanges(openapiDocument(), changed(addRoute, version))).toEqual(expected);
  });

  it("reads the single-number version of the first published document as 1.0.0", () => {
    const before = structuredClone(openapiDocument()) as Obj;
    node(before, "info").version = "1";
    expect(breakingChanges(before, openapiDocument())).toEqual([]);
  });
});
