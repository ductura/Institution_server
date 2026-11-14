import { describe, expect, it } from "vitest";

import { openapiDocument } from "../../scripts/index.ts";
import { breakingChanges } from "./breaking.ts";

type Obj = Record<string, unknown>;

/** The object under a chain of keys; a missing one fails the test instead of passing quietly. */
function node(value: unknown, ...keys: string[]): Obj {
  const found = keys.reduce<unknown>((v, k) => (v as Obj | undefined)?.[k], value);
  if (typeof found !== "object" || found === null || Array.isArray(found))
    throw new Error(`no object at ${keys.join(".")}`);
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
const ok = (d: Obj, path: string) =>
  node(responses(d, path), "200", "content", JSON_TYPE, "schema");
const okProps = (d: Obj, path: string) => node(ok(d, path), "properties");
const localeBody = (d: Obj) =>
  node(op(d, LOCALE, "post"), "requestBody", "content", JSON_TYPE, "schema");
const loginQuery = (d: Obj) => list(op(d, LOGIN), "parameters");
const returnTo = (d: Obj) => node(loginQuery(d), "0");
const formBody = (d: Obj) =>
  node(
    op(d, BACKCHANNEL, "post"),
    "requestBody",
    "content",
    "application/x-www-form-urlencoded",
    "schema",
  );
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
  [
    "operationId changed",
    (d) => (op(d, HEALTH).operationId = "platform.alive.get"),
    [`GET ${HEALTH}: operationId changed`],
  ],
  [
    "access changed",
    (d) => (op(d, HEALTH)["x-access"] = "signed_in"),
    [`GET ${HEALTH}: access changed`],
  ],
  ["new route", addRoute, []],
  [
    "new method on a path",
    (d) => (node(paths(d), HEALTH).post = structuredClone(op(d, HEALTH))),
    [],
  ],
  // Parameters
  [
    "parameter removed",
    (d) => loginQuery(d).pop(),
    [`GET ${LOGIN}: parameter query:returnTo removed`],
  ],
  [
    "parameter became required",
    (d) => (returnTo(d).required = true),
    [`GET ${LOGIN}: parameter query:returnTo became required`],
  ],
  [
    "new required parameter",
    (d) => loginQuery(d).push({ name: "x", in: "query", required: true, schema: str }),
    [`GET ${LOGIN}: new required parameter query:x`],
  ],
  [
    "new optional parameter",
    (d) => loginQuery(d).push({ name: "x", in: "query", required: false, schema: str }),
    [],
  ],
  [
    "parameter type changed",
    (d) => (returnTo(d).schema = { type: "number" }),
    [`GET ${LOGIN} parameter query:returnTo: type changed from string to number`],
  ],
  // Request body
  [
    "request body added",
    (d) =>
      (op(d, HEALTH).requestBody = {
        required: true,
        content: { [JSON_TYPE]: { schema: { type: "object" } } },
      }),
    [`GET ${HEALTH}: request body added`],
  ],
  [
    "request body removed",
    (d) => delete op(d, LOCALE, "post").requestBody,
    [`POST ${LOCALE}: request body removed`],
  ],
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
  [
    "new optional field in a closed request",
    (d) => (node(localeBody(d), "properties").theme = str),
    [],
  ],
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
  [
    "request closed to extra fields",
    (d) => (formBody(d).additionalProperties = false),
    [`POST ${BACKCHANNEL} body: extra fields no longer accepted`],
  ],
  [
    "request extra fields narrowed to a schema",
    (d) => (formBody(d).additionalProperties = str),
    [`POST ${BACKCHANNEL} body: extra fields now constrained`],
  ],
  ["request extra fields allowed as anything", (d) => (formBody(d).additionalProperties = {}), []],
  [
    "request minLength raised",
    (d) => (token(d).minLength = 2),
    [`POST ${BACKCHANNEL} body.logout_token: minLength raised`],
  ],
  [
    "request maxLength added",
    (d) => (token(d).maxLength = 10),
    [`POST ${BACKCHANNEL} body.logout_token: maxLength lowered`],
  ],
  [
    "request format added",
    (d) => (token(d).format = "uuid"),
    [`POST ${BACKCHANNEL} body.logout_token: format changed`],
  ],
  ["request minLength lowered", (d) => (token(d).minLength = 0), []],
  [
    "new constrained field in an open request",
    (d) => (node(formBody(d), "properties").extra = { type: "string", maxLength: 1 }),
    [`POST ${BACKCHANNEL} body.extra: field now constrained`],
  ],
  [
    "new unconstrained field in an open request",
    (d) => (node(formBody(d), "properties").extra = {}),
    [],
  ],
  [
    "request minProperties added",
    (d) => (formBody(d).minProperties = 2),
    [`POST ${BACKCHANNEL} body: minProperties raised`],
  ],
  [
    "request maxProperties added",
    (d) => (formBody(d).maxProperties = 1),
    [`POST ${BACKCHANNEL} body: maxProperties lowered`],
  ],
  [
    "request accepts a new value",
    (d) => list(localeBody(d), "properties", "locale", "anyOf").push(de),
    [],
  ],
  [
    "request no longer accepts a value",
    (d) => list(localeBody(d), "properties", "locale", "anyOf").pop(),
    [`POST ${LOCALE} body.locale: no longer accepted {"const":"en","type":"string"}`],
  ],
  // Success responses
  [
    "success status removed",
    (d) => delete responses(d, HEALTH)["200"],
    [`GET ${HEALTH}: response 200 removed`],
  ],
  [
    "success body removed",
    (d) => delete node(responses(d, HEALTH), "200").content,
    [`GET ${HEALTH}: response 200 body removed`],
  ],
  [
    "response field removed",
    (d) => {
      delete okProps(d, HEALTH).status;
      ok(d, HEALTH).required = [];
    },
    [`GET ${HEALTH} response 200.status: field removed`],
  ],
  [
    "response field became optional",
    (d) => (ok(d, HEALTH).required = []),
    [`GET ${HEALTH} response 200.status: field became optional`],
  ],
  [
    "response type changed",
    (d) => (okProps(d, STATUS).checkedAt = { type: "number" }),
    [`GET ${STATUS} response 200.checkedAt: type changed from string to number`],
  ],
  [
    "response const changed",
    (d) => (node(okProps(d, HEALTH), "status").const = "alive"),
    [`GET ${HEALTH} response 200.status: value changed`],
  ],
  [
    "new value in a response",
    (d) => list(okProps(d, LOCALE), "locale", "anyOf").push(de),
    [`GET ${LOCALE} response 200.locale: new in response {"const":"de","type":"string"}`],
  ],
  [
    "response header removed",
    (d) => (node(responses(d, LOGIN), "303").headers = {}),
    [
      `GET ${LOGIN}: response 303 header location removed`,
      `GET ${LOGIN}: response 303 header set-cookie removed`,
    ],
  ],
  ["new optional response field", (d) => (okProps(d, HEALTH).uptime = { type: "number" }), []],
  ["new success status", (d) => (responses(d, HEALTH)["204"] = { description: "x" }), []],
  ["response maxLength changed", (d) => (node(okProps(d, STATUS), "checkedAt").maxLength = 30), []],
  // Errors
  [
    "new error code on an existing status",
    (d) => (node(responses(d, LOCALE), "403").description = "forbidden, made_up"),
    [],
  ],
  ["error status removed", (d) => delete responses(d, LOCALE)["503"], []],
];

describe("breaking changes", () => {
  it("an unchanged document with the same version breaks nothing", () => {
    expect(breakingChanges(openapiDocument(), openapiDocument())).toEqual([]);
  });

  it.each(CASES)("%s", (name, edit, expected) => {
    expect(breakingChanges(openapiDocument(), changed(edit))).toEqual(expected);
  });
});

describe("schema for extra request fields", () => {
  const withExtra = (extra: unknown, version: string) =>
    changed((d) => (formBody(d).additionalProperties = extra), version);

  it("a narrower schema for extra fields breaks, a wider one does not", () => {
    const before = withExtra(str, "1.1.0");
    expect(breakingChanges(before, withExtra({ type: "string", maxLength: 3 }, "1.2.0"))).toEqual([
      `POST ${BACKCHANNEL} body.*: maxLength lowered`,
    ]);
    expect(breakingChanges(before, withExtra({ type: "number" }, "1.2.0"))).toEqual([
      `POST ${BACKCHANNEL} body.*: type changed from string to number`,
    ]);
    expect(breakingChanges(before, withExtra({}, "1.2.0"))).toEqual([]);
    expect(breakingChanges(before, withExtra(true, "1.2.0"))).toEqual([]);
  });
});

// Every keyword the guard does not compare one by one must still be caught when it
// changes, or a request could be narrowed through it unnoticed.
describe("other schema keywords", () => {
  it.each<[string, (d: Obj) => void]>([
    ["enum added", (d) => (token(d).enum = ["a"])],
    [
      "exclusiveMinimum added",
      (d) => (returnTo(d).schema = { type: "string", exclusiveMinimum: 1 }),
    ],
    ["multipleOf added", (d) => (token(d).multipleOf = 2)],
    ["pattern properties added", (d) => (formBody(d).patternProperties = { "^x": str })],
    ["property names added", (d) => (formBody(d).propertyNames = { maxLength: 3 })],
    ["dependentRequired added", (d) => (formBody(d).dependentRequired = { a: ["b"] })],
    ["allOf added", (d) => (token(d).allOf = [{ maxLength: 3 }])],
    ["not added", (d) => (token(d).not = { const: "x" })],
    ["uniqueItems added", (d) => (token(d).uniqueItems = true)],
    ["contentEncoding added", (d) => (token(d).contentEncoding = "base64")],
  ])("request %s breaks", (name, edit) => {
    expect(breakingChanges(openapiDocument(), changed(edit))).not.toEqual([]);
  });

  it("names the keyword that changed", () => {
    expect(
      breakingChanges(
        openapiDocument(),
        changed((d) => (token(d).multipleOf = 2)),
      ),
    ).toEqual([`POST ${BACKCHANNEL} body.logout_token: multipleOf changed`]);
  });

  it("an enum may widen in a request and narrow in a response, not the other way", () => {
    const at = `POST ${BACKCHANNEL} body.logout_token`;
    const before = changed((d) => (token(d).enum = ["a", "b"]));
    const after = (values: unknown) =>
      breakingChanges(
        before,
        changed((d) => (token(d).enum = values), "1.2.0"),
      );
    expect(after(["a", "b", "c"])).toEqual([]);
    expect(after(["a"])).toEqual([`${at}: no longer accepted "b"`]);
    const status = `GET ${HEALTH} response 200.status`;
    const resp = changed((d) => (node(okProps(d, HEALTH), "status").enum = ["ok", "slow"]));
    const respAfter = (values: unknown) =>
      breakingChanges(
        resp,
        changed((d) => (node(okProps(d, HEALTH), "status").enum = values), "1.2.0"),
      );
    expect(respAfter(["ok"])).toEqual([]);
    expect(respAfter(["ok", "slow", "down"])).toEqual([`${status}: new in response "down"`]);
  });

  it("a constraint beside alternatives counts", () => {
    expect(
      breakingChanges(
        openapiDocument(),
        changed((d) => (node(localeBody(d), "properties", "locale").maxLength = 1)),
      ),
    ).toEqual([`POST ${LOCALE} body.locale: maxLength changed beside alternatives`]);
  });

  it("annotations and vendor keys break nothing", () => {
    const after = changed((d) => {
      token(d).description = "opaque";
      token(d).title = "token";
      token(d).examples = ["a"];
      token(d)["x-note"] = 1;
    });
    expect(breakingChanges(openapiDocument(), after)).toEqual([]);
  });
});

describe("request narrowing outside the field schemas", () => {
  it("a field removed from an open request is judged by the new extra-field schema", () => {
    const before = changed(
      (d) => (formBody(d).additionalProperties = { type: "string", maxLength: 5 }),
    );
    const after = changed((d) => {
      formBody(d).additionalProperties = { type: "string", maxLength: 5 };
      delete node(formBody(d), "properties").logout_token;
      formBody(d).required = [];
    }, "1.2.0");
    expect(breakingChanges(before, after)).toEqual([
      `POST ${BACKCHANNEL} body.logout_token: maxLength lowered`,
    ]);
  });

  it("a request body that became required breaks", () => {
    const optional = (version: string) =>
      changed((d) => (node(op(d, LOCALE, "post"), "requestBody").required = false), version);
    expect(
      breakingChanges(
        optional("1.1.0"),
        changed(() => undefined, "1.2.0"),
      ),
    ).toEqual([`POST ${LOCALE}: request body became required`]);
    expect(
      breakingChanges(
        changed(() => undefined),
        optional("1.2.0"),
      ),
    ).toEqual([]);
  });

  it("a parameter serialization change breaks", () => {
    expect(
      breakingChanges(
        openapiDocument(),
        changed((d) => (returnTo(d).style = "form")),
      ),
    ).toEqual([`GET ${LOGIN}: parameter query:returnTo style changed`]);
  });

  it("a media type encoding change breaks", () => {
    const after = changed(
      (d) =>
        (node(
          op(d, BACKCHANNEL, "post"),
          "requestBody",
          "content",
          "application/x-www-form-urlencoded",
        ).encoding = { logout_token: { contentType: "text/plain" } }),
    );
    expect(breakingChanges(openapiDocument(), after)).toEqual([
      `POST ${BACKCHANNEL}: content type application/x-www-form-urlencoded encoding changed`,
    ]);
  });
});

// Names such as "toString" or "__proto__" exist on every object through its prototype;
// only own keys of the document may count.
describe("inherited key names", () => {
  const ownKey = (o: Obj, key: string, value: unknown) =>
    Object.defineProperty(o, key, { value, enumerable: true, writable: true, configurable: true });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
    "a response field named %s that is removed is reported",
    (key) => {
      const before = changed((d) => ownKey(okProps(d, HEALTH), key, {}));
      expect(
        breakingChanges(
          before,
          changed(() => undefined, "1.2.0"),
        ),
      ).toEqual([`GET ${HEALTH} response 200.${key}: field removed`]);
    },
  );

  it.each(["toString", "constructor", "__proto__", "valueOf"])(
    "a new constrained request field named %s in an open request is reported",
    (key) => {
      const after = changed((d) => ownKey(node(formBody(d), "properties"), key, { maxLength: 1 }));
      expect(breakingChanges(openapiDocument(), after)).toEqual([
        `POST ${BACKCHANNEL} body.${key}: field now constrained`,
      ]);
    },
  );

  it("a success status, header or content type named like a prototype key is compared", () => {
    const before = changed((d) => {
      ownKey(responses(d, HEALTH), "constructor", { description: "x" });
      ownKey(node(responses(d, LOGIN), "303", "headers"), "toString", { schema: str });
      ownKey(node(op(d, LOCALE, "post"), "requestBody", "content"), "valueOf", { schema: str });
    });
    expect(
      breakingChanges(
        before,
        changed(() => undefined, "1.2.0"),
      ),
    ).toEqual([
      `GET ${LOGIN}: response 303 header toString removed`,
      `GET ${HEALTH}: response constructor removed`,
      `POST ${LOCALE}: content type valueOf removed`,
    ]);
  });
});

describe("version field", () => {
  it.each([
    [
      "changed document, same version",
      "1.0.0",
      ["info.version: the document changed but the version did not rise above 1.0.0"],
    ],
    ["changed document, patch raised", "1.0.1", []],
    ["changed document, minor raised", "1.1.0", []],
    [
      "version lowered",
      "0.9.0",
      [
        "info.version: major changed from 1 to 0; a new major is a new document",
        "info.version: lowered from 1.0.0 to 0.9.0",
      ],
    ],
    [
      "new major in the v1 document",
      "2.0.0",
      ["info.version: major changed from 1 to 2; a new major is a new document"],
    ],
    ["not major.minor.patch", "1.1", ["info.version: 1.1 is not major.minor.patch"]],
  ])("%s", (name, version, expected) => {
    expect(breakingChanges(openapiDocument(), changed(addRoute, version))).toEqual(expected);
  });

  it("reads the single-number version of the first published document as 1.0.0", () => {
    const before = structuredClone(openapiDocument()) as Obj;
    node(before, "info").version = "1";
    expect(breakingChanges(before, openapiDocument())).toEqual([]);
  });
});
