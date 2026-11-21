// S-1M-c (DAN-802): every error status the preloader shows has a code and a
// key with a text in hr and en, and an uncaught error is recorded as
// server_error with nothing of the error but its closed class.
import { afterEach, describe, expect, it, vi } from "vitest";

import { messagesEn, messagesHr, textOf, type MessageKey } from "../../locales/index.ts";
import {
  ERROR_MESSAGE_KEYS,
  ROUTES,
  SERVER_ERRORS,
  SHARED_ERRORS,
  TOO_MANY_REQUESTS,
} from "../contracts/index.ts";
import { checkEvent, EVENT_CATALOG, type LogWriter } from "../log/index.ts";
import {
  catalogErrorFor,
  catalogErrorOf,
  createServerErrorReporter,
  ERROR_CATALOG,
  reportServerError,
  ROUTE_429_CODES,
  route429Problems,
  SERVER_ERROR_CLASSES,
  serverErrorClass,
  SESSION_EXPIRED,
} from "./error-catalog.ts";
import { knownError } from "./problem.ts";

afterEach(() => vi.restoreAllMocks());

const CANARY = "made-up-canary-5d21";
const STATUSES = [400, 401, 403, 404, 408, 429, 500, 502, 503, 504];

describe("ERROR_CATALOG", () => {
  it("has the ten statuses, session_expired and session_idle_expired, one code and one key each", () => {
    const byCodeOnly = [SESSION_EXPIRED, "session_idle_expired"];
    const byStatus = ERROR_CATALOG.filter((error) => !byCodeOnly.includes(error.code));
    expect(byStatus.map((error) => error.status)).toEqual(STATUSES);
    expect(catalogErrorOf(SESSION_EXPIRED)).toMatchObject({ status: 401 });
    // SRV-1401: picked by code; by status 401 stays unauthenticated.
    expect(catalogErrorOf("session_idle_expired")).toMatchObject({ status: 401 });
    expect(catalogErrorFor(401)).toMatchObject({ code: "unauthenticated" });
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

  it("a route answers 429 only with a code of ROUTE_429_CODES", () => {
    expect(route429Problems(ROUTES.flatMap((route) => route.errors))).toEqual([]);
    expect(catalogErrorFor(429)).toMatchObject({ code: "too_many_requests" });
  });

  it("the only shared 429 is the rate limit's too_many_requests, the catalogue's own (DAN-814)", () => {
    expect(SHARED_ERRORS.filter((spec) => spec.status === 429)).toEqual([TOO_MANY_REQUESTS.error]);
    expect(catalogErrorFor(429)).toEqual({
      status: 429,
      code: "too_many_requests",
      messageKey: TOO_MANY_REQUESTS.error.key,
    });
    expect(knownError(429, "too_many_requests")).toBe(TOO_MANY_REQUESTS.error);
  });

  it("another 429 code is refused, and a listed code only goes with 429", () => {
    expect(
      route429Problems([
        { status: 429, code: "too_many_reports" },
        { status: 429, code: "too_many_attempts" },
        { status: 429, code: "too_many_requests" },
        { status: 429, code: "slow_down" },
        { status: 400, code: "slow_down" },
        { status: 400, code: "too_many_attempts" },
      ]),
    ).toEqual([
      "429 too_many_requests: not a route 429 code",
      "429 slow_down: not a route 429 code",
      "400 too_many_attempts: a route 429 code on another status",
    ]);
    // The list itself is the decision (c.6905867488); a new code is a new decision.
    expect(ROUTE_429_CODES).toEqual(["too_many_reports", "too_many_attempts"]);
    expect(Object.isFrozen(ROUTE_429_CODES)).toBe(true);
  });

  it("a code under clientErrors is not a contract code (yet)", () => {
    // When the contract gets session_expired (S-1D-d), the entry moves to that
    // contract error and its text to errors.*. 429 stays here and generic:
    // routes answer it with their own ROUTE_429_CODES (DAN-803, c.6905867488).
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

// S-1K.3-b (DAN-812, plan ductura/server#109, A9 to A12).
describe("createServerErrorReporter", () => {
  const REQUEST_ID = "3f2a7c1e-9b4d-4e8a-a1c2-0d5e6f708192";

  it("is reportServerError without a log service (A11)", () => {
    expect(createServerErrorReporter()).toBe(reportServerError);
  });

  it("writes error.unexpected that the catalog admits, without awaiting it (A9)", () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const inputs: unknown[] = [];
    const log: LogWriter = (input) => {
      inputs.push(input);
      return new Promise(() => {});
    };
    const report = createServerErrorReporter(log);
    // Returns synchronously although the write never settles.
    expect(report("route", new RangeError(CANARY), REQUEST_ID, "platform.health.get")).toBe(
      undefined,
    );
    report("layer", new Error(CANARY), REQUEST_ID);
    report("request", CANARY, REQUEST_ID);
    expect(inputs).toHaveLength(3);
    expect(inputs[0]).toMatchObject({
      event: "error.unexpected",
      requestId: REQUEST_ID,
      accountKind: "anonymous",
      fields: { area: "http", errorClass: "range_error" },
    });
    for (const input of inputs) {
      expect(checkEvent(input, { routes: new Set() }).ok).toBe(true);
      expect(JSON.stringify(input)).not.toContain(CANARY);
    }
    expect(logged).not.toHaveBeenCalled();
  });

  it("never throws when the writer throws or rejects", async () => {
    const throwing: LogWriter = () => {
      throw new Error(CANARY);
    };
    const rejecting: LogWriter = () => Promise.reject(new Error(CANARY));
    for (const log of [throwing, rejecting])
      expect(() =>
        createServerErrorReporter(log)("route", new Error("x"), REQUEST_ID),
      ).not.toThrow();
    await new Promise((resolve) => setImmediate(resolve));
  });
});
