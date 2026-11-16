import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isSensitiveKey } from "../index.ts";
import {
  CATALOG_ERROR_CODES,
  catalogMessageKey,
  checkEvent,
  EVENT_CATALOG,
  EVENT_KINDS,
  type EventKind,
  type FieldSpec,
  isEventKind,
  LOG_ACCOUNT_KINDS,
  LOG_ACTORS,
} from "./catalog.ts";

// Invented values only: a made-up sentence stands for the text of a work.
const WORK_TEXT = "Uvod: ovaj izmišljeni rad o kanarincima nije stvaran.";
const REQUEST_ID = "3f2a7c1e-9b4d-4e8a-a1c2-0d5e6f708192";
const OTHER_ID = "0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9";
const ROUTE = "/api/v1/works/:workId";
const ROUTES: ReadonlySet<string> = new Set([ROUTE]);
const TIME = "2026-11-16T09:30:00.000Z";
const SPECS = EVENT_CATALOG as Record<
  EventKind,
  { actors: readonly string[]; fields: Record<string, FieldSpec> }
>;

function validValue(spec: FieldSpec): string | number | boolean {
  switch (spec.kind) {
    case "code":
      return spec.values[0] ?? "";
    case "int":
      return spec.min;
    case "flag":
      return true;
    case "id":
      return OTHER_ID;
    case "version":
      return "1.4.0";
    case "route":
      return ROUTE;
  }
}

function validFields(kind: EventKind): Record<string, string | number | boolean> {
  const fields: Record<string, string | number | boolean> = {};
  for (const [name, spec] of Object.entries(SPECS[kind].fields)) fields[name] = validValue(spec);
  return fields;
}

function validRecord(kind: EventKind): Record<string, unknown> {
  return {
    time: TIME,
    event: kind,
    requestId: REQUEST_ID,
    accountKind: SPECS[kind].actors[0],
    fields: validFields(kind),
  };
}

const check = (input: unknown) => checkEvent(input, { routes: ROUTES });
const codeOf = (input: unknown) => {
  const result = check(input);
  return result.ok ? "OK" : result.error.code;
};

describe("event catalog", () => {
  it("is a closed, non-empty list of dotted lowercase kinds", () => {
    expect(EVENT_KINDS.length).toBeGreaterThan(0);
    expect(new Set(EVENT_KINDS).size).toBe(EVENT_KINDS.length);
    for (const kind of EVENT_KINDS) expect(kind).toMatch(/^[a-z]+\.[a-z0-9_]+$/);
    expect(Object.isFrozen(EVENT_KINDS)).toBe(true);
  });

  it("covers every area the task names", () => {
    const areas = new Set(EVENT_KINDS.map((kind) => kind.split(".")[0]));
    for (const area of [
      ...["authn", "session", "authz", "traffic", "external", "admin", "metrics"],
      ...["client", "legal", "backup", "deletion", "warning"],
    ]) {
      expect(areas).toContain(area);
    }
  });

  it("gives every kind a schema with at least one allowed actor", () => {
    for (const kind of EVENT_KINDS) {
      const spec = SPECS[kind];
      expect(spec, kind).toBeDefined();
      expect(spec.actors.length, kind).toBeGreaterThan(0);
      for (const actor of spec.actors) expect(LOG_ACTORS).toContain(actor);
      expect(check(validRecord(kind)), kind).toMatchObject({ ok: true });
    }
  });

  it("has no field kind that takes free text", () => {
    const allowed = new Set(["code", "int", "flag", "id", "version", "route"]);
    for (const kind of EVENT_KINDS) {
      for (const [name, spec] of Object.entries(SPECS[kind].fields)) {
        expect(allowed, `${kind}.${name}`).toContain(spec.kind);
        expect(name, `${kind}.${name}`).toMatch(/^[a-z][a-zA-Z]{1,30}$/);
        // A name the redactor drops would lose its value in the log line.
        expect(isSensitiveKey(name), `${kind}.${name}`).toBe(false);
        if (spec.kind === "code") {
          expect(spec.values.length).toBeGreaterThan(0);
          for (const value of spec.values) expect(value).toMatch(/^[A-Za-z0-9_]{1,40}$/);
        }
      }
    }
  });

  it("lists anonymous as the only actor that is not an account kind", () => {
    expect(
      LOG_ACTORS.filter((actor) => !(LOG_ACCOUNT_KINDS as readonly string[]).includes(actor)),
    ).toEqual(["anonymous"]);
  });
});

describe("checkEvent: event kind", () => {
  const record = validRecord("authn.logout");
  it.each([
    "AUTHN.LOGOUT",
    "Authn.logout",
    " authn.logout",
    "authn.logout ",
    "authn.logout\n",
    "authn.logout\u0000",
    "authn․logout",
    "authn.lоgout", // Cyrillic о
    "authn.logout​",
    "authn",
    "",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "valueOf",
  ])("refuses the unknown kind %j", (event) => {
    expect(codeOf({ ...record, event })).toBe("UNKNOWN_EVENT");
    expect(isEventKind(event)).toBe(false);
  });

  it.each([undefined, null, 1, true, ["authn.logout"], { toString: () => "authn.logout" }])(
    "refuses a kind that is not a string: %j",
    (event) => {
      expect(codeOf({ ...record, event })).toBe("UNKNOWN_EVENT");
    },
  );
});

describe("checkEvent: account kind", () => {
  it("refuses a record without an account kind", () => {
    const rest = validRecord("traffic.request");
    delete rest.accountKind;
    expect(codeOf(rest)).toBe("MISSING_KEY");
    expect(codeOf({ ...rest, accountKind: undefined })).toBe("UNKNOWN_ACCOUNT_KIND");
  });

  it.each([
    "",
    "Student",
    "STUDENT",
    " student",
    "admin",
    "system",
    "__proto__",
    "toString",
    null,
    0,
  ])("refuses the unknown account kind %j", (accountKind) => {
    expect(codeOf({ ...validRecord("traffic.request"), accountKind })).toBe("UNKNOWN_ACCOUNT_KIND");
  });

  it("refuses an account kind the event does not allow", () => {
    expect(codeOf({ ...validRecord("admin.action"), accountKind: "student" })).toBe(
      "ACCOUNT_KIND_NOT_ALLOWED",
    );
    expect(codeOf({ ...validRecord("admin.action"), accountKind: "anonymous" })).toBe(
      "ACCOUNT_KIND_NOT_ALLOWED",
    );
    expect(codeOf({ ...validRecord("authn.login_failed"), accountKind: "teacher" })).toBe(
      "ACCOUNT_KIND_NOT_ALLOWED",
    );
  });

  it("accepts every actor an event lists and anonymous where allowed", () => {
    for (const kind of EVENT_KINDS) {
      for (const actor of SPECS[kind].actors) {
        expect(codeOf({ ...validRecord(kind), accountKind: actor }), `${kind} ${actor}`).toBe("OK");
      }
    }
  });
});

describe("checkEvent: no text of a work gets through", () => {
  it("refuses the text in every field of every event", () => {
    for (const kind of EVENT_KINDS) {
      for (const name of Object.keys(SPECS[kind].fields)) {
        const record = validRecord(kind);
        record.fields = { ...validFields(kind), [name]: WORK_TEXT };
        expect(codeOf(record), `${kind}.${name}`).toBe("BAD_FIELD_VALUE");
      }
    }
  });

  it("refuses the text under an extra field, at the top level or nested", () => {
    for (const kind of EVENT_KINDS) {
      expect(
        codeOf({ ...validRecord(kind), fields: { ...validFields(kind), note: WORK_TEXT } }),
      ).toBe("UNKNOWN_FIELD");
      expect(codeOf({ ...validRecord(kind), message: WORK_TEXT })).toBe("UNKNOWN_KEY");
    }
    expect(
      codeOf({
        ...validRecord("authz.denied"),
        fields: { ...validFields("authz.denied"), action: { text: WORK_TEXT } },
      }),
    ).toBe("BAD_FIELD_VALUE");
    expect(
      codeOf({
        ...validRecord("authz.denied"),
        fields: { ...validFields("authz.denied"), action: [WORK_TEXT] },
      }),
    ).toBe("BAD_FIELD_VALUE");
  });

  it("refuses text shaped like an id, a version or a route", () => {
    const record = validRecord("deletion.draft_deleted");
    for (const workId of [
      "moj-rad-o-kanarincima",
      OTHER_ID.toUpperCase(),
      ` ${OTHER_ID}`,
      `${OTHER_ID}x`,
    ]) {
      expect(codeOf({ ...record, fields: { workId } })).toBe("BAD_FIELD_VALUE");
    }
    const client = validRecord("client.context_reported");
    for (const appVersion of ["1.4.0-uvod-o-kanarincima", "1.4.0 ", "v1.4.0", "1.4"]) {
      expect(
        codeOf({ ...client, fields: { ...validFields("client.context_reported"), appVersion } }),
      ).toBe("BAD_FIELD_VALUE");
    }
    const traffic = validRecord("traffic.request");
    for (const route of [
      "/api/v1/ovaj-izmisljeni-rad-o-kanarincima",
      `${ROUTE}?q=uvod`,
      "/api/v1/works/7",
    ]) {
      expect(codeOf({ ...traffic, fields: { ...validFields("traffic.request"), route } })).toBe(
        "BAD_FIELD_VALUE",
      );
    }
    // Without an inventory no route passes at all.
    expect(checkEvent(traffic)).toMatchObject({ ok: false, error: { code: "BAD_FIELD_VALUE" } });
  });

  it("refuses a code from another field or another case", () => {
    const record = validRecord("traffic.request");
    expect(
      codeOf({ ...record, fields: { ...validFields("traffic.request"), method: "get" } }),
    ).toBe("BAD_FIELD_VALUE");
    expect(
      codeOf({ ...record, fields: { ...validFields("traffic.request"), ipRule: "limited" } }),
    ).toBe("BAD_FIELD_VALUE");
  });

  it("refuses numbers outside the bounds and non-integers", () => {
    const record = validRecord("traffic.request");
    for (const status of [99, 600, 200.5, Number.NaN, Number.POSITIVE_INFINITY, "200", 2n]) {
      expect(codeOf({ ...record, fields: { ...validFields("traffic.request"), status } })).toBe(
        "BAD_FIELD_VALUE",
      );
    }
  });
});

describe("checkEvent: shape", () => {
  const good = validRecord("session.created");

  it.each([null, undefined, "x", 1, [], [good], new Date(), new Map()])("refuses %j", (input) => {
    expect(codeOf(input)).toBe("NOT_A_PLAIN_OBJECT");
  });

  it("refuses a missing field, a missing fields object and an extra top-level key", () => {
    expect(codeOf({ ...good, fields: {} })).toBe("MISSING_FIELD");
    const rest = { ...good };
    delete rest.fields;
    expect(codeOf(rest)).toBe("MISSING_KEY");
    expect(codeOf({ ...good, level: "info" })).toBe("UNKNOWN_KEY");
  });

  it("refuses a __proto__ own key from JSON, at the top and in fields", () => {
    const top = JSON.parse(
      `{"__proto__":{"text":"${WORK_TEXT}"},${JSON.stringify(good).slice(1)}`,
    ) as unknown;
    expect(codeOf(top)).toBe("UNKNOWN_KEY");
    const inner = JSON.parse(
      JSON.stringify(good).replace('"fields":{', `"fields":{"__proto__":{"text":"${WORK_TEXT}"},`),
    ) as unknown;
    expect(codeOf(inner)).toBe("UNKNOWN_FIELD");
  });

  it("refuses a getter, a symbol key, a class instance and a proxy", () => {
    const getter = { ...good };
    Object.defineProperty(getter, "event", { enumerable: true, get: () => "session.created" });
    expect(codeOf(getter)).toBe("NOT_A_PLAIN_OBJECT");
    expect(codeOf({ ...good, [Symbol("text")]: WORK_TEXT })).toBe("UNKNOWN_KEY");
    class Fields {
      secondFactor = true;
    }
    expect(codeOf({ ...good, fields: new Fields() })).toBe("NOT_A_PLAIN_OBJECT");
    expect(codeOf(new Proxy({ ...good }, {}))).toBe("NOT_A_PLAIN_OBJECT");
    expect(codeOf({ ...good, fields: new Proxy({ secondFactor: true }, {}) })).toBe(
      "NOT_A_PLAIN_OBJECT",
    );
  });

  it("accepts a null-prototype object", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, good, {
      fields: Object.assign(Object.create(null) as Record<string, unknown>, {
        secondFactor: false,
      }),
    });
    expect(codeOf(bare)).toBe("OK");
  });

  it.each([
    "2026-11-16T09:30:00Z",
    "2026-11-16T09:30:00.000+01:00",
    "2026-02-30T09:30:00.000Z",
    "2026-11-16 09:30:00.000Z",
    ` ${TIME}`,
    1_700_000_000_000,
  ])("refuses the time %j", (time) => {
    expect(codeOf({ ...good, time })).toBe("BAD_TIME");
  });

  it.each([
    REQUEST_ID.toUpperCase(),
    "3f2a7c1e-9b4d-1e8a-a1c2-0d5e6f708192",
    `${REQUEST_ID} `,
    "",
    "req-1",
    WORK_TEXT,
    null,
  ])("refuses the request id %j", (requestId) => {
    expect(codeOf({ ...good, requestId })).toBe("BAD_REQUEST_ID");
  });

  it("returns a fresh frozen copy, not the input", () => {
    const input = validRecord("session.created");
    const result = check(input);
    if (!result.ok) throw new Error(result.error.code);
    expect(result.value).not.toBe(input);
    expect(result.value.fields).not.toBe(input.fields);
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.fields)).toBe(true);
    expect(result.value).toEqual(input);
  });

  it("never echoes the refused value", () => {
    const result = check({ ...good, fields: { secondFactor: WORK_TEXT } });
    expect(JSON.stringify(result)).not.toContain("kanarinc");
  });
});

describe("catalog and options cannot be bent (adversarial QA findings)", () => {
  it("freezes the catalog all the way down", () => {
    const seen: unknown[] = [];
    const walk = (value: unknown): void => {
      if (typeof value !== "object" || value === null) return;
      expect(Object.isFrozen(value)).toBe(true);
      seen.push(value);
      for (const child of Object.values(value)) walk(child);
    };
    walk(EVENT_CATALOG);
    expect(seen.length).toBeGreaterThan(EVENT_KINDS.length * 2);
    const values = (SPECS["authn.login_started"].fields.method as unknown as { values: string[] })
      .values;
    expect(() => values.push(WORK_TEXT)).toThrow(TypeError);
    expect(() => {
      SPECS["session.expired"].fields.note = { kind: "code", values: [WORK_TEXT] };
    }).toThrow(TypeError);
    expect(codeOf({ ...validRecord("authn.login_started"), fields: { method: WORK_TEXT } })).toBe(
      "BAD_FIELD_VALUE",
    );
  });

  it("never throws on bad options and refuses the record instead", () => {
    const record = validRecord("traffic.request");
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    const bad: unknown[] = [
      null,
      1,
      "routes",
      revoked.proxy,
      new Proxy({ routes: ROUTES }, {}),
      Object.defineProperty({}, "routes", {
        get: () => {
          throw new Error("boom");
        },
      }),
      { routes: [ROUTE] },
      { routes: { has: () => true } },
      { routes: new Proxy(new Set([ROUTE]), {}) },
    ];
    for (const options of bad) {
      expect(() => checkEvent(record, options as never)).not.toThrow();
      expect(checkEvent(record, options as never)).toMatchObject({
        ok: false,
        error: { code: "BAD_OPTIONS" },
      });
    }
  });

  it("uses Set.prototype.has, not a has the inventory brings", () => {
    const sneaky = new Set([ROUTE]);
    Object.defineProperty(sneaky, "has", { value: () => true });
    const record = validRecord("traffic.request");
    record.fields = { ...validFields("traffic.request"), route: "/api/v1/moj-izmisljeni-rad" };
    expect(checkEvent(record, { routes: sneaky })).toMatchObject({
      ok: false,
      error: { code: "BAD_FIELD_VALUE" },
    });
  });

  it("freezes the result wrapper and keeps fields off Object.prototype", () => {
    const ok = check(validRecord("session.created"));
    expect(Object.isFrozen(ok)).toBe(true);
    const refused = check(null);
    expect(Object.isFrozen(refused)).toBe(true);
    if (!ok.ok) throw new Error(ok.error.code);
    expect(Object.getPrototypeOf(ok.value.fields)).toBeNull();
  });
});

describe("error shape (docs/CODE_STYLE.md §8)", () => {
  const hr = JSON.parse(
    readFileSync(new URL("../../../locales/hr.json", import.meta.url), "utf8"),
  ) as { logCatalog: Record<string, string> };

  it("refuses with exactly a code and its static message key", () => {
    expect(check(null)).toEqual({
      ok: false,
      error: { code: "NOT_A_PLAIN_OBJECT", messageKey: "logCatalog.not_a_plain_object" },
    });
    const result = check({ ...validRecord("authn.logout"), event: "AUTHN.LOGOUT" });
    expect(result).toEqual({
      ok: false,
      error: { code: "UNKNOWN_EVENT", messageKey: "logCatalog.unknown_event" },
    });
    if (!result.ok) expect(Object.keys(result.error).sort()).toEqual(["code", "messageKey"]);
  });

  it("has a Croatian text in locales/hr.json for every message key, and no extra text", () => {
    const keys = CATALOG_ERROR_CODES.map(catalogMessageKey);
    expect(new Set(keys).size).toBe(keys.length);
    for (const errorCode of CATALOG_ERROR_CODES) {
      const key = catalogMessageKey(errorCode);
      expect(errorCode).toMatch(/^[A-Z_]+$/);
      expect(key).toBe(`logCatalog.${errorCode.toLowerCase()}`);
      expect(hr.logCatalog[key.slice("logCatalog.".length)], key).toMatch(/\S/);
    }
    expect(Object.keys(hr.logCatalog).length).toBe(keys.length);
  });
});
