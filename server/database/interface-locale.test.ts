// DAN-851-1c1 (contract Ductus#1836 c.6936040386): the interface language port
// turns every outcome of identity.interface_locale() and
// identity.set_interface_locale() into a closed result and never throws.
// Every token and value below is invented.
import { afterEach, describe, expect, it, vi } from "vitest";

import { createInterfaceLocaleStore, type InterfaceLocaleStore } from "./interface-locale.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-jezika-0000000000000000001";
const READ_SQL = "SELECT identity.interface_locale() AS locale";
const SET_SQL = "SELECT identity.set_interface_locale($1) AS locale";
const SECRET = "tajna poruka baze s izmisljenim SQL-om";

type Answer = { rows?: unknown; throws?: unknown; actorThrows?: unknown };

function store(answer: Answer) {
  const calls = {
    withActor: 0,
    queries: [] as { text: string; values: unknown; token: unknown }[],
  };
  const withActor = (async (token, fn) => {
    calls.withActor += 1;
    if ("actorThrows" in answer) throw answer.actorThrows;
    const tx = {
      async query(text: string, values?: readonly unknown[]) {
        calls.queries.push({ text, values, token });
        if ("throws" in answer) throw answer.throws;
        return { rows: answer.rows, rowCount: 0 };
      },
    } as unknown as ActorTransaction;
    return fn(tx);
  }) as WithActor;
  return { port: createInterfaceLocaleStore(withActor), calls };
}

const both = (port: InterfaceLocaleStore) => [port.read(TOKEN), port.save(TOKEN, "hr")] as const;
const dbError = (code: unknown) => Object.assign(new Error(SECRET), { code });

const spies = () => [
  vi.spyOn(console, "error"),
  vi.spyOn(console, "warn"),
  vi.spyOn(console, "log"),
  vi.spyOn(console, "info"),
];
afterEach(() => vi.restoreAllMocks());

describe("interface language port: refusals", () => {
  it("ZD401 is unauthenticated for read and save", async () => {
    const { port } = store({ throws: dbError("ZD401") });
    for (const outcome of await Promise.all(both(port)))
      expect(outcome).toEqual({ status: "unauthenticated" });
  });

  it("ZD422 is invalid for save and unavailable for read", async () => {
    const { port } = store({ throws: dbError("ZD422") });
    expect(await port.save(TOKEN, "en")).toEqual({ status: "invalid" });
    expect(await port.read(TOKEN)).toEqual({ status: "unavailable", reason: "ZD422" });
  });

  it.each([["zd401"], ["ZD401 "], ["ZD4011"], ["zd401 "]])(
    "%j is not ZD401: unknown",
    async (code) => {
      const { port } = store({ throws: dbError(code) });
      for (const outcome of await Promise.all(both(port)))
        expect(outcome).toEqual({ status: "unavailable", reason: "unknown" });
    },
  );

  it("another SQLSTATE is unavailable with that code", async () => {
    const { port } = store({ throws: dbError("57014") });
    for (const outcome of await Promise.all(both(port)))
      expect(outcome).toEqual({ status: "unavailable", reason: "57014" });
  });

  const throwingGetter = Object.defineProperty(new Error(SECRET), "code", {
    get() {
      throw new Error(SECRET);
    },
  });
  const throwingHas = new Proxy(
    {},
    {
      has() {
        throw new Error(SECRET);
      },
    },
  );
  const throwingGet = new Proxy(
    { code: "ZD401" },
    {
      get() {
        throw new Error(SECRET);
      },
    },
  );
  it.each([
    ["no code", new Error(SECRET)],
    ["numeric code", dbError(401)],
    ["code __proto__", dbError("__proto__")],
    ["null-prototype error", Object.create(null) as object],
    ["string", SECRET],
    ["null", null],
    ["undefined", undefined],
    ["throwing code getter", throwingGetter],
    ["Proxy with a throwing has", throwingHas],
    ["Proxy with a throwing get", throwingGet],
  ])("%s is unavailable with unknown and nothing is thrown", async (_name, thrown) => {
    const { port } = store({ throws: thrown });
    for (const outcome of await Promise.all(both(port)))
      expect(outcome).toEqual({ status: "unavailable", reason: "unknown" });
  });

  it("an inherited ZD401 code counts, as Ductus `in` reads it", async () => {
    const { port } = store({ throws: Object.create({ code: "ZD401" }) as object });
    expect(await port.read(TOKEN)).toEqual({ status: "unauthenticated" });
  });

  it("a throw from withActor itself is unavailable", async () => {
    const { port } = store({ actorThrows: dbError("08006") });
    for (const outcome of await Promise.all(both(port)))
      expect(outcome).toEqual({ status: "unavailable", reason: "08006" });
    const { port: bare } = store({ actorThrows: new Error(SECRET) });
    expect(await bare.read(TOKEN)).toEqual({ status: "unavailable", reason: "unknown" });
  });
});

describe("interface language port: rows", () => {
  const malformed = { status: "unavailable", reason: "row_malformed" };

  it.each([
    ["no row", []],
    ["two rows", [{ locale: "hr" }, { locale: "hr" }]],
    ["an undefined row", [undefined]],
    ["rows not an array", { 0: { locale: "hr" }, length: 1 }],
    ["rows undefined", undefined],
  ])("%s is row_malformed", async (_name, rows) => {
    const { port } = store({ rows });
    for (const outcome of await Promise.all(both(port))) expect(outcome).toEqual(malformed);
  });

  it.each([
    "HR",
    "de",
    "hr\r\n",
    "\thr",
    "hr ",
    "hr\u007f",
    "toString",
    1,
    { locale: "hr" },
    new String("hr"),
  ])("the value %j is row_malformed", async (locale) => {
    const { port } = store({ rows: [{ locale }] });
    for (const outcome of await Promise.all(both(port))) expect(outcome).toEqual(malformed);
  });

  it("save answers row_malformed for null or a value other than the one sent", async () => {
    expect(await store({ rows: [{ locale: null }] }).port.save(TOKEN, "hr")).toEqual(malformed);
    expect(await store({ rows: [{ locale: "en" }] }).port.save(TOKEN, "hr")).toEqual(malformed);
  });
});

describe("interface language port: success and calls", () => {
  it.each(["hr", "en", null])("read answers %j", async (locale) => {
    expect(await store({ rows: [{ locale }] }).port.read(TOKEN)).toEqual({ status: "ok", locale });
  });

  it.each(["hr", "en"] as const)("save answers the saved %s", async (locale) => {
    expect(await store({ rows: [{ locale }] }).port.save(TOKEN, locale)).toEqual({
      status: "ok",
      locale,
    });
  });

  it("each method is one withActor call with the token and one query with its SQL", async () => {
    const read = store({ rows: [{ locale: null }] });
    await read.port.read(TOKEN);
    expect(read.calls.withActor).toBe(1);
    expect(read.calls.queries).toEqual([{ text: READ_SQL, values: [], token: TOKEN }]);
    const save = store({ rows: [{ locale: "en" }] });
    await save.port.save(TOKEN, "en");
    expect(save.calls.withActor).toBe(1);
    expect(save.calls.queries).toEqual([{ text: SET_SQL, values: ["en"], token: TOKEN }]);
    for (const { text, values } of [...read.calls.queries, ...save.calls.queries])
      expect(JSON.stringify([text, values])).not.toContain(TOKEN);
  });

  it("logs nothing and leaks no message, SQL, parameter or token", async () => {
    const watched = spies();
    const outcomes = [
      ...(await Promise.all(both(store({ throws: dbError("57014") }).port))),
      ...(await Promise.all(both(store({ throws: new Error(SECRET) }).port))),
      ...(await Promise.all(both(store({ rows: [{ locale: SECRET }] }).port))),
    ];
    for (const spy of watched) expect(spy).not.toHaveBeenCalled();
    const text = JSON.stringify(outcomes);
    for (const leak of [SECRET, "identity.", "SELECT", TOKEN]) expect(text).not.toContain(leak);
  });
});
