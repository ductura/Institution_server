// DAN-851-2c1 (contract Ductus#1836 c.6944497890): the problem report port
// turns every outcome of identity.submit_problem_report() into a closed result
// and never throws. Every token, text and reference below is invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ProblemReport } from "../domain/index.ts";
import {
  createProblemReportStore,
  PROBLEM_REPORT_DATABASE_ERROR,
  PROBLEM_REPORT_ERRORS,
  PROBLEM_REPORT_INVALID,
  PROBLEM_REPORT_PARAMETERS,
  PROBLEM_REPORT_ROW_MALFORMED,
  PROBLEM_REPORT_TOO_MANY,
  PROBLEM_REPORT_UNAUTHENTICATED,
} from "./problem-report.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-prijave-000000000000000001";
const SQL =
  "SELECT identity.submit_problem_report($1, $2, $3, $4, $5, $6::integer, $7) AS reference";
const SECRET = "tajna poruka baze s izmisljenim SQL-om";
const CANARY = "kanarinac-opisa-prijave";
const REFERENCE = "PR-0A1B2C3D4E";

// Seven distinct values, so a swap of any two parameters shows.
const REPORT: ProblemReport = {
  category: "technical",
  description: `Izmišljeni opis ${CANARY}`,
  route: "/kako-radi",
  appVersion: "1.2.3",
  browserFamily: "firefox",
  browserMajor: 128,
  syncState: "SYNCED",
};
const IN_ORDER = ["technical", REPORT.description, "/kako-radi", "1.2.3", "firefox", 128, "SYNCED"];

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
  return { port: createProblemReportStore(withActor), calls };
}

const submit = (answer: Answer, report: ProblemReport = REPORT) =>
  store(answer).port.submit(TOKEN, report);
const dbError = (code: unknown) => Object.assign(new Error(SECRET), { code });
const fail = (error: unknown) => ({ ok: false, error });
const DATABASE = fail(PROBLEM_REPORT_DATABASE_ERROR);
const MALFORMED = fail(PROBLEM_REPORT_ROW_MALFORMED);

const spies = () => [
  vi.spyOn(console, "error"),
  vi.spyOn(console, "warn"),
  vi.spyOn(console, "log"),
  vi.spyOn(console, "info"),
];
afterEach(() => vi.restoreAllMocks());

const catalogue: unknown = JSON.parse(
  readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
);
const lookup = (key: string): unknown =>
  key
    .split(".")
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
      catalogue,
    );

describe("problem report port errors (docs/CODE_STYLE.md §8)", () => {
  it("has a Croatian text in locales/hr.json for every messageKey", () => {
    for (const error of PROBLEM_REPORT_ERRORS) {
      const text = lookup(error.messageKey);
      expect(typeof text === "string" && text.trim().length > 0, error.messageKey).toBe(true);
    }
  });

  it("lists five errors with distinct UPPER_SNAKE codes and keys", () => {
    expect(PROBLEM_REPORT_ERRORS).toHaveLength(5);
    for (const { code } of PROBLEM_REPORT_ERRORS)
      expect(code).toMatch(/^PROBLEM_REPORT_[A-Z]+(?:_[A-Z]+)*$/);
    expect(new Set(PROBLEM_REPORT_ERRORS.map((e) => e.code)).size).toBe(5);
    expect(new Set(PROBLEM_REPORT_ERRORS.map((e) => e.messageKey)).size).toBe(5);
  });
});

describe("problem report port: refusals", () => {
  it.each([
    ["ZD401", PROBLEM_REPORT_UNAUTHENTICATED],
    ["ZD422", PROBLEM_REPORT_INVALID],
    ["ZD429", PROBLEM_REPORT_TOO_MANY],
  ])("%s is its own error", async (code, error) => {
    expect(await submit({ throws: dbError(code) })).toEqual(fail(error));
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
    { code: "ZD429" },
    {
      get() {
        throw new Error(SECRET);
      },
    },
  );
  it.each([
    ["ZD500 (not READ COMMITTED)", dbError("ZD500")],
    ["ZD503 (no free reference)", dbError("ZD503")],
    ["40001", dbError("40001")],
    ["lower-case zd401", dbError("zd401")],
    ["ZD429 with a space", dbError("ZD429 ")],
    ["numeric 401", dbError(401)],
    ["no code", new Error(SECRET)],
    ["null-prototype error", Object.create(null) as object],
    ["a thrown string", SECRET],
    ["null", null],
    ["undefined", undefined],
    ["a throwing code getter", throwingGetter],
    ["a Proxy with a throwing has", throwingHas],
    ["a Proxy with a throwing get", throwingGet],
  ])("%s is a database error and nothing is thrown", async (_name, thrown) => {
    expect(await submit({ throws: thrown })).toEqual(DATABASE);
  });

  it("a throw from withActor itself is a database error", async () => {
    expect(await submit({ actorThrows: dbError("08006") })).toEqual(DATABASE);
    expect(await submit({ actorThrows: new Error(SECRET) })).toEqual(DATABASE);
  });
});

describe("problem report port: rows", () => {
  it.each([
    ["no row", []],
    ["two valid rows", [{ reference: REFERENCE }, { reference: "PR-1111111111" }]],
    ["rows not an array", { 0: { reference: REFERENCE }, length: 1 }],
    ["rows undefined", undefined],
    ["a null row", [null]],
    ["a string row", [REFERENCE]],
    ["a row without reference", [{}]],
  ])("%s is row_malformed", async (_name, rows) => {
    expect(await submit({ rows })).toEqual(MALFORMED);
  });

  // QA c.6944920837: reading what withActor answered can throw too (a getter
  // or a Proxy); that is row_malformed, never a rejected promise or a message.
  const boom = () => {
    throw new Error(SECRET);
  };
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  it.each([
    ["a throwing reference getter", () => [Object.defineProperty({}, "reference", { get: boom })]],
    ["a row Proxy with a throwing get", () => [new Proxy({ reference: REFERENCE }, { get: boom })]],
    ["rows with a throwing length", () => new Proxy([{ reference: REFERENCE }], { get: boom })],
    ["a revoked rows Proxy", () => revoked.proxy],
    [
      "a throwing index getter",
      () => Object.defineProperty([{ reference: REFERENCE }], 0, { get: boom }),
    ],
  ])("%s is row_malformed and nothing is thrown", async (_name, rows) => {
    const outcome = await submit({ rows: rows() });
    expect(outcome).toEqual(MALFORMED);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  it("a result whose rows getter throws, or no result at all, is row_malformed", async () => {
    for (const result of [Object.defineProperty({}, "rows", { get: boom }), null, undefined]) {
      const withActor = (async () => result) as unknown as WithActor;
      expect(await createProblemReportStore(withActor).submit(TOKEN, REPORT)).toEqual(MALFORMED);
    }
  });

  it.each([
    1234567890,
    null,
    "pr-0a1b2c3d4e",
    "PR-0a1b2c3d4e",
    "PR-0A1B2C3D4",
    "PR-0A1B2C3D4E5",
    "xPR-0A1B2C3D4E",
    " PR-0A1B2C3D4E",
    "PR-0A1B2C3D4E ",
    "PR-0A1B2C3D4E\n",
    "PR-0A1B2C3D4G",
    "PR_0A1B2C3D4E",
    new String(REFERENCE),
    CANARY,
  ])("the reference %j is row_malformed", async (reference) => {
    expect(await submit({ rows: [{ reference }] })).toEqual(MALFORMED);
  });
});

describe("problem report port: success and calls", () => {
  it("answers the reference after one withActor call and one query in signature order", async () => {
    const { port, calls } = store({ rows: [{ reference: REFERENCE }] });
    expect(await port.submit(TOKEN, REPORT)).toEqual({ ok: true, value: REFERENCE });
    expect(calls.withActor).toBe(1);
    expect(calls.queries).toEqual([{ text: SQL, values: IN_ORDER, token: TOKEN }]);
    expect(JSON.stringify(calls.queries.map((q) => [q.text, q.values]))).not.toContain(TOKEN);
  });

  it("sends the parameters named by PROBLEM_REPORT_PARAMETERS, in that order", async () => {
    expect(PROBLEM_REPORT_PARAMETERS).toEqual([
      "category",
      "description",
      "route",
      "appVersion",
      "browserFamily",
      "browserMajor",
      "syncState",
    ]);
    const { port, calls } = store({ rows: [{ reference: REFERENCE }] });
    await port.submit(TOKEN, REPORT);
    expect(calls.queries[0]?.values).toEqual(PROBLEM_REPORT_PARAMETERS.map((key) => REPORT[key]));
  });

  it("passes a missing route, major and sync state as null", async () => {
    const { port, calls } = store({ rows: [{ reference: REFERENCE }] });
    const report = { ...REPORT, route: null, browserMajor: null, syncState: null };
    expect(await port.submit(TOKEN, report)).toEqual({ ok: true, value: REFERENCE });
    expect(calls.queries[0]?.values).toEqual([
      "technical",
      REPORT.description,
      null,
      "1.2.3",
      "firefox",
      null,
      null,
    ]);
  });

  it("logs nothing and leaks no message, SQL, description, value or token", async () => {
    const watched = spies();
    const outcomes = [
      await submit({ throws: dbError("40001") }),
      await submit({ throws: dbError("ZD429") }),
      await submit({ throws: new Error(SECRET) }),
      await submit({ rows: [{ reference: CANARY }] }),
      await submit({ rows: [] }),
    ];
    for (const spy of watched) expect(spy).not.toHaveBeenCalled();
    const text = JSON.stringify(outcomes);
    for (const leak of [SECRET, CANARY, "identity.", "SELECT", "40001", TOKEN])
      expect(text).not.toContain(leak);
  });
});

describe("problem report port: a course report (SRV-ADMIN-1)", () => {
  const COURSE = "00000000-0000-4000-8000-0000000000c1";
  const COURSE_SQL =
    "SELECT identity.submit_course_problem_report($1::uuid, $2, $3, $4, $5, $6::integer, $7) AS reference";

  it("calls the course RPC with the course in place of the category", async () => {
    const { port, calls } = store({ rows: [{ reference: REFERENCE }] });
    const course = { ...REPORT, category: "course" as const };
    expect(await port.submit(TOKEN, course, COURSE)).toEqual({ ok: true, value: REFERENCE });
    expect(calls.queries).toEqual([
      { text: COURSE_SQL, values: [COURSE, ...IN_ORDER.slice(1)], token: TOKEN },
    ]);
  });

  it("keeps the plain call when no course is named", async () => {
    const { port, calls } = store({ rows: [{ reference: REFERENCE }] });
    await port.submit(TOKEN, REPORT);
    expect(calls.queries.map((query) => query.text)).toEqual([SQL]);
  });

  it("a course outside the reporter's reach is the database's ZD422", async () => {
    const { port } = store({ throws: dbError("ZD422") });
    expect(await port.submit(TOKEN, { ...REPORT, category: "course" }, COURSE)).toEqual(
      fail(PROBLEM_REPORT_INVALID),
    );
  });
});
