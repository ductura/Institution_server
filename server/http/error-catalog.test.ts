// S-1M-c (DAN-802): every error status the preloader shows has a code and a
// key with a text in hr and en, and an uncaught error is recorded as
// server_error with nothing of the error but its closed class.
import { afterEach, describe, expect, it, vi } from "vitest";

import { messagesEn, messagesHr, textOf, type MessageKey } from "../../locales/index.ts";
import { ERROR_MESSAGE_KEYS, SERVER_ERRORS } from "../contracts/index.ts";
import { EVENT_CATALOG } from "../log/index.ts";
import {
  catalogErrorFor,
  catalogErrorOf,
  ERROR_CATALOG,
  reportServerError,
  SERVER_ERROR_CLASSES,
  serverErrorClass,
  SESSION_EXPIRED,
} from "./error-catalog.ts";
import { knownError } from "./problem.ts";

afterEach(() => vi.restoreAllMocks());

const CANARY = "made-up-canary-5d21";
const STATUSES = [400, 401, 403, 404, 408, 429, 500, 502, 503, 504];

describe("ERROR_CATALOG", () => {
  it("has the ten statuses and session_expired, one code and one key each", () => {
    const byStatus = ERROR_CATALOG.filter((error) => error.code !== SESSION_EXPIRED);
    expect(byStatus.map((error) => error.status)).toEqual(STATUSES);
    expect(catalogErrorOf(SESSION_EXPIRED)).toMatchObject({ status: 401 });
    expect(new Set(ERROR_CATALOG.map((error) => error.code)).size).toBe(ERROR_CATALOG.length);
    expect(new Set(ERROR_CATALOG.map((error) => error.messageKey)).size).toBe(ERROR_CATALOG.length);
  });

  it.each(ERROR_CATALOG.map((error) => [error.code, error.messageKey]))(
    "%s has a text in hr and en (%s)",
    (_code, key) => {
      expect(textOf(messagesHr, key as MessageKey)).toEqual(expect.stringMatching(/\S/u));
      expect(textOf(messagesEn, key as MessageKey)).toEqual(expect.stringMatching(/\S/u));
    },
  );

  it("a status the server answers names that status's contract error and key", () => {
    const answered = new Set(SERVER_ERRORS.map((spec) => spec.status));
    for (const error of ERROR_CATALOG) {
      if (error.code === SESSION_EXPIRED || !answered.has(error.status)) continue;
      expect(knownError(error.status, error.code)?.key, error.code).toBe(error.messageKey);
    }
  });

  it("a code under clientErrors is not a contract code (yet)", () => {
    // When the contract gets 429 (S-1C.3) or session_expired (S-1D-d), the
    // entry moves to that contract error and its text to errors.*.
    for (const error of ERROR_CATALOG.filter((e) => e.messageKey.startsWith("clientErrors.")))
      expect(ERROR_MESSAGE_KEYS.has(error.code), error.code).toBe(false);
  });

  it("clientErrors in hr and en has no text the catalogue does not use", () => {
    const used = new Set(ERROR_CATALOG.map((error) => error.messageKey));
    for (const table of [messagesHr, messagesEn])
      expect(
        Object.keys(table.clientErrors).filter((name) => !used.has(`clientErrors.${name}`)),
      ).toEqual([]);
  });

  it("a key missing in en is caught", () => {
    const copy = structuredClone(messagesEn) as { clientErrors: Record<string, string> };
    delete copy.clientErrors["badGateway"];
    expect(() => textOf(copy as typeof messagesEn, "clientErrors.badGateway")).toThrow();
  });

  it("is frozen to the bottom", () => {
    expect(Object.isFrozen(ERROR_CATALOG)).toBe(true);
    for (const error of ERROR_CATALOG) expect(Object.isFrozen(error)).toBe(true);
  });
});

describe("catalogErrorFor", () => {
  it("gives each status its own entry; 401 by status stays unauthenticated", () => {
    for (const status of STATUSES) expect(catalogErrorFor(status).status).toBe(status);
    expect(catalogErrorFor(401).code).toBe("unauthenticated");
  });

  it("gives 400 for another 4xx and 500 for anything else", () => {
    for (const status of [402, 405, 418, 499])
      expect(catalogErrorFor(status).code).toBe("bad_request");
    for (const status of [0, 200, 302, 399, 501, 599, 600, -1, 1.5, Number.NaN, Infinity])
      expect(catalogErrorFor(status).code).toBe("internal");
    for (const status of ["500", null, undefined, {}, 404n])
      expect(catalogErrorFor(status).code).toBe("internal");
  });

  it("catalogErrorOf reads only the catalogue's own codes", () => {
    for (const code of ["__proto__", "toString", "constructor", "", "Internal"])
      expect(catalogErrorOf(code)).toBeUndefined();
  });
});

describe("reportServerError", () => {
  const lines = () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    return () => logged.mock.calls.map((call) => call.map(String).join(" "));
  };

  it("writes one server_error line with the site, class, request id and route", () => {
    const read = lines();
    reportServerError("route", new TypeError(CANARY), "id-1", "platform.health.get");
    expect(read()).toHaveLength(1);
    expect(JSON.parse(read()[0] ?? "")).toEqual({
      event: "server_error",
      where: "route",
      errorClass: "type_error",
      requestId: "id-1",
      route: "platform.health.get",
    });
  });

  it("never carries the message, stack, subclass name or cause", () => {
    class Canary extends Error {
      override name = CANARY;
    }
    const withCause = new Error(CANARY, { cause: CANARY });
    withCause.stack = CANARY;
    const thrown: unknown[] = [
      new Error(CANARY),
      new Canary(CANARY),
      withCause,
      CANARY,
      { message: CANARY, name: CANARY },
      Object.assign(new RangeError(CANARY), { name: CANARY }),
    ];
    const read = lines();
    for (const [i, error] of thrown.entries()) reportServerError("request", error, `id-${i}`);
    expect(read()).toHaveLength(thrown.length);
    for (const line of read()) {
      expect(line).not.toContain(CANARY);
      expect(Object.keys(JSON.parse(line) as object).sort()).toEqual([
        "errorClass",
        "event",
        "requestId",
        "where",
      ]);
    }
  });

  it("gives a closed class for anything thrown, never throwing", () => {
    const getter = Object.defineProperty(new Error("x"), "name", {
      get() {
        throw new Error(CANARY);
      },
    });
    const { proxy, revoke } = Proxy.revocable(new Error("x"), {});
    revoke();
    const values: unknown[] = [
      null,
      undefined,
      Symbol(CANARY),
      getter,
      proxy,
      new Proxy(new Error("x"), {}),
      new SyntaxError("x"),
      new ReferenceError("x"),
    ];
    for (const value of values) expect(SERVER_ERROR_CLASSES).toContain(serverErrorClass(value));
    expect(serverErrorClass(new SyntaxError("x"))).toBe("syntax_error");
    expect(serverErrorClass(new ReferenceError("x"))).toBe("reference_error");
  });

  it("a broken stderr does not throw", () => {
    vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error(CANARY);
    });
    expect(() => reportServerError("layer", new Error(CANARY), "id")).not.toThrow();
  });

  it("its classes are classes of error.unexpected, so it binds there with area http", () => {
    const fields = EVENT_CATALOG["error.unexpected"].fields as unknown as Record<
      string,
      { readonly values: readonly string[] }
    >;
    expect(fields["area"]?.values).toContain("http");
    for (const errorClass of SERVER_ERROR_CLASSES)
      expect(fields["errorClass"]?.values).toContain(errorClass);
  });
});
