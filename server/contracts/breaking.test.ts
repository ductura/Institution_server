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
const READY = "/api/v1/ready";
const LOCALE = "/api/v1/profile/interface-locale";
const STATUS = "/api/v1/status";
const LOGIN = "/api/v1/auth/login";
const BACKCHANNEL = "/api/v1/auth/backchannel-logout";
const JSON_TYPE = "application/json";
const FORM_TYPE = "application/x-www-form-urlencoded";

// JSON pointers as the guard prints them ("/" inside a key is written "~1").
const OK = "responses/200/content/application~1json/schema";
const JSON_BODY = "requestBody/content/application~1json/schema";
const FORM_BODY = "requestBody/content/application~1x-www-form-urlencoded/schema";
const RETURN_TO = "parameters/query:returnTo";
const TOKEN = `${FORM_BODY}/properties/logout_token`;
const LOCALE_FIELD = `${JSON_BODY}/properties/locale`;

const paths = (d: Obj) => node(d, "paths");
const op = (d: Obj, path: string, method = "get") => node(d, "paths", path, method);
const responses = (d: Obj, path: string, method = "get") => node(op(d, path, method), "responses");
const ok = (d: Obj, path: string) =>
  node(responses(d, path), "200", "content", JSON_TYPE, "schema");
const okProps = (d: Obj, path: string) => node(ok(d, path), "properties");
const localeBody = (d: Obj) =>
  node(op(d, LOCALE, "post"), "requestBody", "content", JSON_TYPE, "schema");
const loginQuery = (d: Obj) => list(op(d, LOGIN), "parameters");
const returnTo = (d: Obj) => node(loginQuery(d), "0");
const formBody = (d: Obj) =>
  node(op(d, BACKCHANNEL, "post"), "requestBody", "content", FORM_TYPE, "schema");
const token = (d: Obj) => node(formBody(d), "properties", "logout_token");
const limit = (d: Obj, by: number) => {
  const post = op(d, LOCALE, "post");
  post["x-max-body-bytes"] = (post["x-max-body-bytes"] as number) + by;
};
const addRoute = (d: Obj) => (paths(d)["/api/v1/made-up"] = structuredClone(paths(d)[HEALTH]));
const str = { type: "string" };
const hr = { const: "hr", type: "string" };
const en = { const: "en", type: "string" };
const de = { const: "de", type: "string" };

// [class, edit, expected problems]. Closed by default: every difference in an
// existing route is reported, whether or not it would narrow or widen.
const BREAKING: [string, (d: Obj) => void, string[]][] = [
  // Findings of rounds 1 and 2 (codex 9455ad26, cxcrs10 and cxcqs10 on 44f05e18 and 8e0946a6)
  [
    "round 2: response format date-time becomes uri",
    (d) => (node(okProps(d, STATUS), "checkedAt").format = "uri"),
    [`GET ${STATUS} ${OK}/properties/checkedAt/format: changed`],
  ],
  [
    "round 2: old request alternatives wrapped in a nested anyOf with maxLength",
    (d) =>
      (node(localeBody(d), "properties").locale = {
        anyOf: [{ anyOf: [hr, en], maxLength: 1 }, de],
      }),
    [
      `POST ${LOCALE} ${LOCALE_FIELD}/anyOf/0/anyOf: added`,
      `POST ${LOCALE} ${LOCALE_FIELD}/anyOf/0/const: removed`,
      `POST ${LOCALE} ${LOCALE_FIELD}/anyOf/0/maxLength: added`,
      `POST ${LOCALE} ${LOCALE_FIELD}/anyOf/0/type: removed`,
      `POST ${LOCALE} ${LOCALE_FIELD}/anyOf/1/const: changed`,
    ],
  ],
  [
    "round 2: maxLength beside anyOf only in the new document",
    (d) =>
      (node(formBody(d), "properties").logout_token = {
        anyOf: [{ type: "string", minLength: 1 }, { type: "null" }],
        maxLength: 3,
      }),
    [
      `POST ${BACKCHANNEL} ${TOKEN}/anyOf: added`,
      `POST ${BACKCHANNEL} ${TOKEN}/maxLength: added`,
      `POST ${BACKCHANNEL} ${TOKEN}/minLength: removed`,
      `POST ${BACKCHANNEL} ${TOKEN}/type: removed`,
    ],
  ],
  [
    "round 1: request extra fields narrowed to a string",
    (d) => (formBody(d).additionalProperties = str),
    [`POST ${BACKCHANNEL} ${FORM_BODY}/additionalProperties: added`],
  ],
  [
    "round 1: request extra fields narrowed to a short string",
    (d) => (formBody(d).additionalProperties = { type: "string", maxLength: 1 }),
    [`POST ${BACKCHANNEL} ${FORM_BODY}/additionalProperties: added`],
  ],
  [
    "round 1: new constrained field in an open request",
    (d) => (node(formBody(d), "properties").extra = { type: "string", maxLength: 1 }),
    [`POST ${BACKCHANNEL} ${FORM_BODY}/properties/extra: field added`],
  ],
  [
    "round 1: request minProperties added",
    (d) => (formBody(d).minProperties = 2),
    [`POST ${BACKCHANNEL} ${FORM_BODY}/minProperties: added`],
  ],
  [
    "round 1: request maxProperties added",
    (d) => (formBody(d).maxProperties = 1),
    [`POST ${BACKCHANNEL} ${FORM_BODY}/maxProperties: added`],
  ],
  // Routes
  ["route removed", (d) => delete paths(d)[HEALTH], [`GET ${HEALTH}: route removed`]],
  ["method removed", (d) => delete node(paths(d), LOCALE).post, [`POST ${LOCALE}: route removed`]],
  [
    "operationId changed",
    (d) => (op(d, HEALTH).operationId = "platform.alive.get"),
    [`GET ${HEALTH} operationId: changed`],
  ],
  [
    "access changed",
    (d) => (op(d, HEALTH)["x-access"] = "signed_in"),
    [`GET ${HEALTH} x-access: changed`],
  ],
  [
    "inventory path written the Windows way",
    (d) =>
      (op(d, HEALTH)["x-inventory"] = String(op(d, HEALTH)["x-inventory"]).replaceAll("/", "\\")),
    [`GET ${HEALTH} x-inventory: changed`],
  ],
  [
    "path-level parameters added",
    (d) => (node(paths(d), HEALTH).parameters = [{ name: "x", in: "query", schema: str }]),
    [`${HEALTH} parameters: added`],
  ],
  [
    "document fallback changed",
    (d) => (node(d, "x-fallback").status = 410),
    ["x-fallback: changed"],
  ],
  // Parameters
  [
    "parameter removed",
    (d) => loginQuery(d).pop(),
    [`GET ${LOGIN} ${RETURN_TO}: parameter removed`],
  ],
  [
    "parameter became required",
    (d) => (returnTo(d).required = true),
    [`GET ${LOGIN} ${RETURN_TO}/required: changed`],
  ],
  [
    "new required parameter",
    (d) => loginQuery(d).push({ name: "x", in: "query", required: true, schema: str }),
    [`GET ${LOGIN} parameters/query:x: parameter added`],
  ],
  [
    "new optional parameter",
    (d) => loginQuery(d).push({ name: "x", in: "query", required: false, schema: str }),
    [`GET ${LOGIN} parameters/query:x: parameter added`],
  ],
  [
    "parameter type changed",
    (d) => (node(returnTo(d), "schema").type = "number"),
    [`GET ${LOGIN} ${RETURN_TO}/schema/type: changed`],
  ],
  [
    "parameter serialization added",
    (d) => (returnTo(d).style = "form"),
    [`GET ${LOGIN} ${RETURN_TO}/style: added`],
  ],
  // Request body
  [
    "request body added",
    (d) =>
      (op(d, HEALTH).requestBody = {
        required: true,
        content: { [JSON_TYPE]: { schema: { type: "object" } } },
      }),
    [`GET ${HEALTH} requestBody: added`],
  ],
  [
    "request body removed",
    (d) => delete op(d, LOCALE, "post").requestBody,
    [`POST ${LOCALE} requestBody: removed`],
  ],
  [
    "request body became optional",
    (d) => (node(op(d, LOCALE, "post"), "requestBody").required = false),
    [`POST ${LOCALE} requestBody/required: changed`],
  ],
  [
    "content type replaced",
    (d) => {
      const c = node(op(d, LOCALE, "post"), "requestBody", "content");
      c["text/plain"] = c[JSON_TYPE];
      delete c[JSON_TYPE];
    },
    [
      `POST ${LOCALE} requestBody/content/application~1json: removed`,
      `POST ${LOCALE} requestBody/content/text~1plain: added`,
    ],
  ],
  [
    "media type encoding added",
    (d) =>
      (node(op(d, BACKCHANNEL, "post"), "requestBody", "content", FORM_TYPE).encoding = {
        logout_token: { contentType: "text/plain" },
      }),
    [`POST ${BACKCHANNEL} requestBody/content/application~1x-www-form-urlencoded/encoding: added`],
  ],
  ["body limit lowered", (d) => limit(d, -1), [`POST ${LOCALE} x-max-body-bytes: changed`]],
  ["body limit raised", (d) => limit(d, 1), [`POST ${LOCALE} x-max-body-bytes: changed`]],
  [
    "new required request field",
    (d) => {
      node(localeBody(d), "properties").theme = str;
      list(localeBody(d), "required").push("theme");
    },
    [
      `POST ${LOCALE} ${JSON_BODY}/properties/theme: field added`,
      `POST ${LOCALE} ${JSON_BODY}/required: changed`,
    ],
  ],
  [
    "field removed from a closed request",
    (d) => {
      delete node(localeBody(d), "properties").locale;
      localeBody(d).required = [];
    },
    [
      `POST ${LOCALE} ${LOCALE_FIELD}: field removed`,
      `POST ${LOCALE} ${JSON_BODY}/required: changed`,
    ],
  ],
  [
    "field removed from an open request",
    (d) => {
      delete node(formBody(d), "properties").logout_token;
      formBody(d).required = [];
    },
    [
      `POST ${BACKCHANNEL} ${TOKEN}: field removed`,
      `POST ${BACKCHANNEL} ${FORM_BODY}/required: changed`,
    ],
  ],
  [
    "request closed to extra fields",
    (d) => (formBody(d).additionalProperties = false),
    [`POST ${BACKCHANNEL} ${FORM_BODY}/additionalProperties: added`],
  ],
  [
    "request extra fields declared as anything",
    (d) => (formBody(d).additionalProperties = {}),
    [`POST ${BACKCHANNEL} ${FORM_BODY}/additionalProperties: added`],
  ],
  [
    "request closed object opened",
    (d) => delete localeBody(d).additionalProperties,
    [`POST ${LOCALE} ${JSON_BODY}/additionalProperties: removed`],
  ],
  [
    "new unconstrained field in an open request",
    (d) => (node(formBody(d), "properties").extra = {}),
    [`POST ${BACKCHANNEL} ${FORM_BODY}/properties/extra: field added`],
  ],
  [
    "new optional field and a closed object in the same change",
    (d) => {
      formBody(d).additionalProperties = false;
      node(formBody(d), "properties").extra = str;
    },
    [
      `POST ${BACKCHANNEL} ${FORM_BODY}/additionalProperties: added`,
      `POST ${BACKCHANNEL} ${FORM_BODY}/properties/extra: field added`,
    ],
  ],
  [
    "request minLength raised",
    (d) => (token(d).minLength = 2),
    [`POST ${BACKCHANNEL} ${TOKEN}/minLength: changed`],
  ],
  [
    "request minLength lowered",
    (d) => (token(d).minLength = 0),
    [`POST ${BACKCHANNEL} ${TOKEN}/minLength: changed`],
  ],
  [
    "request maxLength added",
    (d) => (token(d).maxLength = 10),
    [`POST ${BACKCHANNEL} ${TOKEN}/maxLength: added`],
  ],
  [
    "request format added",
    (d) => (token(d).format = "uuid"),
    [`POST ${BACKCHANNEL} ${TOKEN}/format: added`],
  ],
  [
    "request enum added",
    (d) => (token(d).enum = ["a"]),
    [`POST ${BACKCHANNEL} ${TOKEN}/enum: added`],
  ],
  [
    "request multipleOf added",
    (d) => (token(d).multipleOf = 2),
    [`POST ${BACKCHANNEL} ${TOKEN}/multipleOf: added`],
  ],
  [
    "request allOf added",
    (d) => (token(d).allOf = [{ maxLength: 3 }]),
    [`POST ${BACKCHANNEL} ${TOKEN}/allOf: added`],
  ],
  [
    "request not added",
    (d) => (token(d).not = { const: "x" }),
    [`POST ${BACKCHANNEL} ${TOKEN}/not: added`],
  ],
  [
    "request patternProperties added",
    (d) => (formBody(d).patternProperties = { "^x": str }),
    [`POST ${BACKCHANNEL} ${FORM_BODY}/patternProperties: added`],
  ],
  [
    "request accepts a new value",
    (d) => list(localeBody(d), "properties", "locale", "anyOf").push(de),
    [`POST ${LOCALE} ${LOCALE_FIELD}/anyOf: changed`],
  ],
  [
    "request no longer accepts a value",
    (d) => list(localeBody(d), "properties", "locale", "anyOf").pop(),
    [`POST ${LOCALE} ${LOCALE_FIELD}/anyOf: changed`],
  ],
  [
    "anyOf becomes oneOf with the same alternatives",
    (d) => {
      const locale = node(localeBody(d), "properties", "locale");
      locale.oneOf = locale.anyOf;
      delete locale.anyOf;
    },
    [
      `POST ${LOCALE} ${LOCALE_FIELD}/anyOf: removed`,
      `POST ${LOCALE} ${LOCALE_FIELD}/oneOf: added`,
    ],
  ],
  // Success responses
  [
    "success status removed",
    (d) => delete responses(d, HEALTH)["200"],
    [`GET ${HEALTH} responses/200: removed`],
  ],
  [
    "success body removed",
    (d) => delete node(responses(d, HEALTH), "200").content,
    [`GET ${HEALTH} responses/200/content: removed`],
  ],
  [
    "response field removed",
    (d) => {
      delete okProps(d, HEALTH).status;
      ok(d, HEALTH).required = [];
    },
    [
      `GET ${HEALTH} ${OK}/properties/status: field removed`,
      `GET ${HEALTH} ${OK}/required: changed`,
    ],
  ],
  [
    "response field became optional",
    (d) => (ok(d, HEALTH).required = []),
    [`GET ${HEALTH} ${OK}/required: changed`],
  ],
  [
    "new required response field",
    (d) => {
      okProps(d, HEALTH).uptime = { type: "number" };
      list(ok(d, HEALTH), "required").push("uptime");
    },
    [`GET ${HEALTH} ${OK}/properties/uptime: field added`, `GET ${HEALTH} ${OK}/required: changed`],
  ],
  [
    "response type changed",
    (d) => (okProps(d, STATUS).checkedAt = { type: "number" }),
    [
      `GET ${STATUS} ${OK}/properties/checkedAt/format: removed`,
      `GET ${STATUS} ${OK}/properties/checkedAt/maxLength: removed`,
      `GET ${STATUS} ${OK}/properties/checkedAt/type: changed`,
    ],
  ],
  [
    "response const changed",
    (d) => (node(okProps(d, HEALTH), "status").const = "alive"),
    [`GET ${HEALTH} ${OK}/properties/status/const: changed`],
  ],
  [
    "new value in a response",
    (d) => list(okProps(d, LOCALE), "locale", "anyOf").push(de),
    [`GET ${LOCALE} ${OK}/properties/locale/anyOf: changed`],
  ],
  [
    "response header removed",
    (d) => (node(responses(d, LOGIN), "303").headers = {}),
    [
      `GET ${LOGIN} responses/303/headers/location: removed`,
      `GET ${LOGIN} responses/303/headers/set-cookie: removed`,
    ],
  ],
  [
    "response maxLength changed",
    (d) => (node(okProps(d, STATUS), "checkedAt").maxLength = 30),
    [`GET ${STATUS} ${OK}/properties/checkedAt/maxLength: changed`],
  ],
  [
    "new success status",
    (d) => (responses(d, HEALTH)["204"] = { description: "x" }),
    [`GET ${HEALTH} responses/204: added`],
  ],
  // Errors are part of the route too
  [
    "error status removed",
    (d) => delete responses(d, LOCALE)["503"],
    [`GET ${LOCALE} responses/503: removed`],
  ],
  [
    "new error status",
    (d) => (responses(d, LOCALE)["409"] = { description: "conflict" }),
    [`GET ${LOCALE} responses/409: added`],
  ],
];

// The control characters and look-alike spaces of an input are never trimmed or folded.
const SPACES: [string, string, string][] = [
  ["CRLF", "\r\n", "\\u000d\\u000a"],
  ["tab", "\t", "\\u0009"],
  ["NBSP", String.fromCharCode(0xa0), "\\u00a0"],
  ["DEL", String.fromCharCode(0x7f), "\\u007f"],
];

// The explicit list of safe changes; nothing else passes.
const SAFE: [string, (d: Obj) => void][] = [
  ["new route", addRoute],
  [
    "new method on an existing path",
    (d) => (node(paths(d), HEALTH).post = structuredClone(op(d, HEALTH))),
  ],
  ["new optional response field", (d) => (okProps(d, HEALTH).uptime = { type: "number" })],
  [
    "new optional nested response field",
    (d) => (node(okProps(d, READY), "capabilities", "properties").cache = { type: "boolean" }),
  ],
  [
    "new optional field in a closed request",
    (d) => (node(localeBody(d), "properties").theme = str),
  ],
  ["schema description added", (d) => (token(d).description = "opaque\r\n\tlogout token ")],
  ["schema title added", (d) => (token(d).title = "token")],
  ["schema example added", (d) => (token(d).example = "abc")],
  ["schema examples added", (d) => (token(d).examples = ["abc"])],
  [
    "description inside an alternative",
    (d) =>
      (node(list(localeBody(d), "properties", "locale", "anyOf"), "0").description = "Croatian"),
  ],
  ["operation description added", (d) => (op(d, HEALTH).description = "liveness")],
  [
    "response description changed",
    (d) => (node(responses(d, LOCALE), "403").description = "forbidden, made_up"),
  ],
  ["parameter description added", (d) => (returnTo(d).description = "where to go after sign-in")],
  [
    "media type example added",
    (d) =>
      (node(op(d, LOCALE, "post"), "requestBody", "content", JSON_TYPE).example = { locale: "hr" }),
  ],
  ["document title changed", (d) => (node(d, "info").title = "Ductura API v1")],
];

describe("breaking changes, closed by default", () => {
  it("an unchanged document with the same version breaks nothing", () => {
    expect(breakingChanges(openapiDocument(), openapiDocument())).toEqual([]);
  });

  it.each(BREAKING)("breaks: %s", (name, edit, expected) => {
    expect(breakingChanges(openapiDocument(), changed(edit))).toEqual(expected);
  });

  it.each(SAFE)("safe: %s", (name, edit) => {
    expect(breakingChanges(openapiDocument(), changed(edit))).toEqual([]);
  });

  it.each(SPACES)("a %s added to a value is a change", (name, space) => {
    expect(
      breakingChanges(
        openapiDocument(),
        changed((d) => (node(okProps(d, HEALTH), "status").const = `ok${space}`)),
      ),
    ).toEqual([`GET ${HEALTH} ${OK}/properties/status/const: changed`]);
  });

  it.each(SPACES)(
    "a %s added to a field name is a removed and a new field, printed escaped",
    (name, space, printed) => {
      const after = changed((d) => {
        const props = node(formBody(d), "properties");
        props[`logout_token${space}`] = props.logout_token;
        delete props.logout_token;
        formBody(d).required = [`logout_token${space}`];
      });
      expect(breakingChanges(openapiDocument(), after)).toEqual([
        `POST ${BACKCHANNEL} ${TOKEN}: field removed`,
        `POST ${BACKCHANNEL} ${TOKEN}${printed}: field added`,
        `POST ${BACKCHANNEL} ${FORM_BODY}/required: changed`,
      ]);
    },
  );

  it.each(SPACES)("a %s added to a response field name drops the old field", (name, space) => {
    const after = changed((d) => {
      okProps(d, HEALTH)[`status${space}`] = okProps(d, HEALTH).status;
      delete okProps(d, HEALTH).status;
    });
    expect(breakingChanges(openapiDocument(), after)).toEqual([
      `GET ${HEALTH} ${OK}/properties/status: field removed`,
    ]);
  });

  it("only schema keywords are annotations: a field named description or title is a field", () => {
    const before = changed((d) => {
      okProps(d, HEALTH).description = str;
      okProps(d, HEALTH).title = str;
    });
    expect(
      breakingChanges(
        before,
        changed(() => undefined, "1.2.0"),
      ),
    ).toEqual([
      `GET ${HEALTH} ${OK}/properties/description: field removed`,
      `GET ${HEALTH} ${OK}/properties/title: field removed`,
    ]);
  });

  it("a new field is safe in a request only when the object was and stays closed", () => {
    const open = changed((d) => delete localeBody(d).additionalProperties);
    const openWithTheme = changed((d) => {
      delete localeBody(d).additionalProperties;
      node(localeBody(d), "properties").theme = str;
    }, "1.2.0");
    expect(breakingChanges(open, openWithTheme)).toEqual([
      `POST ${LOCALE} ${JSON_BODY}/properties/theme: field added`,
    ]);
  });

  it("a widened schema for extra request fields is still a change", () => {
    const before = changed(
      (d) => (formBody(d).additionalProperties = { type: "string", maxLength: 3 }),
    );
    expect(
      breakingChanges(
        before,
        changed((d) => (formBody(d).additionalProperties = str), "1.2.0"),
      ),
    ).toEqual([`POST ${BACKCHANNEL} ${FORM_BODY}/additionalProperties/maxLength: removed`]);
  });

  // Review FAIL c.6881215681: {"x": 42} passed through patternProperties despite
  // additionalProperties: false; a new optional x: string rejects it.
  it("a new request field matched by a base patternProperties is breaking", () => {
    const before = changed((d) => (localeBody(d).patternProperties = { "^x": {} }));
    const after = changed((d) => {
      localeBody(d).patternProperties = { "^x": {} };
      node(localeBody(d), "properties").x = str;
    }, "1.2.0");
    expect(breakingChanges(before, after)).toEqual([
      `POST ${LOCALE} ${JSON_BODY}/properties/x: field added`,
    ]);
  });

  // QA FAIL c.6881211641: a looser schema under `not` rejects {"extra": "x"}.
  it.each([
    ["request", (d: Obj) => localeBody(d), `POST ${LOCALE} ${JSON_BODY}`],
    ["response", (d: Obj) => ok(d, HEALTH), `GET ${HEALTH} ${OK}`],
  ])("a new optional field under not in a %s is breaking", (name, at, where) => {
    const closed = () => ({ type: "object", additionalProperties: false, properties: {} });
    const before = changed((d) => (at(d).not = closed()));
    const after = changed((d) => {
      at(d).not = closed();
      node(at(d), "not", "properties").extra = str;
    }, "1.2.0");
    expect(breakingChanges(before, after)).toEqual([`${where}/not/properties/extra: field added`]);
  });

  it("a new optional response field in an open object is still safe", () => {
    const open = (d: Obj) => {
      delete ok(d, HEALTH).additionalProperties;
      ok(d, HEALTH).patternProperties = { "^x-": str };
    };
    const before = changed(open);
    const after = changed((d) => {
      open(d);
      okProps(d, HEALTH).uptime = { type: "number" };
    }, "1.2.0");
    expect(breakingChanges(before, after)).toEqual([]);
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
      ).toEqual([`GET ${HEALTH} ${OK}/properties/${key}: field removed`]);
    },
  );

  it.each(["toString", "constructor", "__proto__", "valueOf"])(
    "a new request field named %s in an open request is reported",
    (key) => {
      const after = changed((d) => ownKey(node(formBody(d), "properties"), key, { maxLength: 1 }));
      expect(breakingChanges(openapiDocument(), after)).toEqual([
        `POST ${BACKCHANNEL} ${FORM_BODY}/properties/${key}: field added`,
      ]);
    },
  );

  it("a field named __proto__ keeps its own schema through normalization", () => {
    const withProto = (maxLength: number, version: string) =>
      changed(
        (d) => ownKey(okProps(d, HEALTH), "__proto__", { type: "string", maxLength }),
        version,
      );
    expect(breakingChanges(withProto(1, "1.1.0"), withProto(2, "1.2.0"))).toEqual([
      `GET ${HEALTH} ${OK}/properties/__proto__/maxLength: changed`,
    ]);
  });

  it("a status, header, content type or path named like a prototype key is compared", () => {
    const before = changed((d) => {
      ownKey(responses(d, HEALTH), "constructor", { description: "x" });
      ownKey(node(responses(d, LOGIN), "303", "headers"), "toString", { schema: str });
      ownKey(node(op(d, LOCALE, "post"), "requestBody", "content"), "valueOf", { schema: str });
      ownKey(paths(d), "__proto__", { get: structuredClone(op(d, HEALTH)) });
    });
    expect(
      breakingChanges(
        before,
        changed(() => undefined, "1.2.0"),
      ),
    ).toEqual([
      `GET ${LOGIN} responses/303/headers/toString: removed`,
      `GET ${HEALTH} responses/constructor: removed`,
      `POST ${LOCALE} requestBody/content/valueOf: removed`,
      "GET __proto__: route removed",
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

  it("a description-only change still needs a higher version", () => {
    expect(
      breakingChanges(
        openapiDocument(),
        changed((d) => (op(d, HEALTH).description = "liveness"), "1.0.0"),
      ),
    ).toEqual(["info.version: the document changed but the version did not rise above 1.0.0"]);
  });

  it("reads the single-number version of the first published document as 1.0.0", () => {
    const before = structuredClone(openapiDocument()) as Obj;
    node(before, "info").version = "1";
    expect(breakingChanges(before, openapiDocument())).toEqual([]);
  });
});
