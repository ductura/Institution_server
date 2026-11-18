// DAN-1084-1b (scope Ductus#2028 c.6971571104): GET /api/v1/student/assignment-work
// on a real server with the real pipeline. The class "shape of the reader's result":
// whatever the reader answers, only a structuredClone snapshot that has no hole,
// own fields only and passes the closed schema leaves as 200; anything else is 503
// with one report, never a partial list. Every token and id is invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { MyAssignmentWorkReader, WithActor } from "../database/index.ts";
import { sessionTag } from "../session/index.ts";

import { createDatabases } from "./databases.ts";
import { createLayers } from "./pipeline.ts";
import type { Route } from "./router.ts";
import { type Running, startServer } from "./start.ts";
import {
  createStudentAssignmentWorkRoute,
  createStudentAssignmentWorkRouteFor,
} from "./student-assignment-work.ts";

type Vector = {
  name: string;
  request: { headers?: Record<string, string> };
  response: { status: number; body: Record<string, unknown> };
};
const VECTORS = (
  JSON.parse(
    readFileSync(
      new URL("../contracts/vectors/student.assignment-work.get.json", import.meta.url),
      "utf8",
    ),
  ) as { vectors: Vector[] }
).vectors;
const COOKIE = VECTORS.find((v) => v.name === "ready")!.request.headers!.cookie!;
const TOKEN = COOKIE.slice("__Host-ductus_session=".length);
const OTHER = "izmisljeni-token-drugog-studenta-0000000002";
const A1 = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e01";
const A2 = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e02";
const GOOD = { assignmentId: A1, workState: "submitted" };
const BAD = { assignmentId: A2, workState: "graded" };

let server: Running | undefined;
let tokens: unknown[] = [];
let lines: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  tokens = [];
  await server?.close();
  server = undefined;
});

async function serve(route: Route) {
  lines = [];
  vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
    lines.push(JSON.stringify(args));
  });
  server = await startServer({
    host: "127.0.0.1",
    port: 0,
    layers: createLayers({ expectedOrigin: "https://ductura.invalid" }),
    databases: createDatabases(),
    routes: [route],
  });
}
/** The route over a stub reader whose answer is `answer()`; `tokens` counts the calls. */
const stub = (answer: () => unknown) =>
  serve(
    createStudentAssignmentWorkRoute({
      reader: {
        read: async (token) => {
          tokens.push(token);
          return answer() as Awaited<ReturnType<MyAssignmentWorkReader["read"]>>;
        },
      },
    }),
  );
const ok = (value: unknown) => () => ({ ok: true, value });

type Answer = { status: number; headers: Headers; body: Record<string, unknown> };
async function get(cookie: string | null = COOKIE, query = "", extra = {}): Promise<Answer> {
  const response = await fetch(
    `http://127.0.0.1:${server!.port}/api/v1/student/assignment-work${query}`,
    {
      headers: { ...(cookie === null ? {} : { cookie }), ...extra },
    },
  );
  const body = (await response.json()) as Record<string, unknown>;
  return { status: response.status, headers: response.headers, body };
}
/** 503 unavailable, at most `reports` route reports of `errorClass`, no id, token or message. */
function unavailable(got: Answer, reports: number, errorClass?: string) {
  expect([got.status, got.body.code]).toEqual([503, "unavailable"]);
  for (const text of [JSON.stringify(got.body), ...lines])
    for (const secret of [A1, A2, TOKEN, OTHER, "tajna"]) expect(text).not.toContain(secret);
  expect(lines.length).toBe(reports);
  if (errorClass !== undefined)
    expect(JSON.parse((JSON.parse(lines[0]!) as [string])[0])).toMatchObject({
      event: "server_error",
      where: "route",
      errorClass,
      route: "student.assignment-work.get",
    });
  expect(tokens).toEqual([TOKEN]);
}

/** Runs `body` with `key` planted on `proto` (a value or a getter), then removes it. */
async function planted(
  proto: object,
  key: string,
  field: PropertyDescriptor,
  body: () => Promise<void>,
) {
  const writable = "value" in field ? { writable: true } : {};
  Object.defineProperty(proto, key, { ...field, ...writable, configurable: true });
  try {
    await body();
  } finally {
    delete (proto as Record<string, unknown>)[key];
  }
}

describe("the class: shape of the reader's result (503, one report, never a 200)", () => {
  const getter = Object.defineProperty({ workState: "submitted" }, "assignmentId", {
    enumerable: true,
    get() {
      throw new TypeError("tajna");
    },
  });
  let iterated = 0;
  it.each([
    [
      "a Proxy with a false length",
      "other",
      ok(new Proxy([GOOD, BAD], { get: (t, k) => (k === "length" ? 1 : Reflect.get(t, k)) })),
    ],
    ["a Proxy over the whole result", "other", () => new Proxy({ ok: true, value: [GOOD] }, {})],
    ["a Proxy item", "other", ok([new Proxy({ ...GOOD }, {})])],
    [
      "an own iterator that skips a bad item",
      "type_error",
      ok(
        Object.assign([GOOD, BAD], {
          *[Symbol.iterator]() {
            iterated += 1;
            yield GOOD;
          },
        }),
      ),
    ],
    ["a getter that throws", "other", ok([getter])],
    ["a function field", "other", ok([{ ...GOOD, f: () => OTHER }])],
    ["a symbol field", "other", ok([{ ...GOOD, s: Symbol(OTHER) }])],
    ["a Date item", "type_error", ok([new Date(0)])],
    ["a Map item", "type_error", ok([new Map(Object.entries(GOOD))])],
    ["an array item", "type_error", ok([[A1, "submitted"]])],
    ["a null item", "type_error", ok([null])],
    ["a number item", "type_error", ok([7])],
    ["a string item", "type_error", ok([A1])],
    ["a field beyond the two", "type_error", ok([{ ...GOOD, studentId: OTHER }])],
    [
      "an own __proto__ key",
      "type_error",
      ok([JSON.parse(`{"__proto__":${JSON.stringify(GOOD)}}`)]),
    ],
    [
      "an own __proto__ key beside the two",
      "type_error",
      ok([JSON.parse(`{"assignmentId":"${A1}","workState":"submitted","__proto__":{}}`)]),
    ],
    ["an own toString key", "type_error", ok([{ ...GOOD, toString: "x" }])],
    ["inherited fields", "type_error", ok([Object.create(GOOD) as object])],
    ["a value that is no array", "type_error", ok(GOOD)],
    ["a state outside the contract", "type_error", ok([BAD])],
    ["an uppercase id", "type_error", ok([{ ...GOOD, assignmentId: A1.toUpperCase() }])],
    ["a non-enumerable item", "type_error", ok(Object.defineProperty([GOOD], 1, { value: GOOD }))],
    [
      "a non-enumerable field",
      "type_error",
      ok([Object.defineProperty({ ...GOOD }, "workState", { enumerable: false })]),
    ],
    [
      "unauthenticated with a function field",
      "other",
      () => ({ ok: false, error: { code: "MY_ASSIGNMENT_WORK_UNAUTHENTICATED", f: () => 1 } }),
    ],
  ] as [string, string, () => unknown][])("%s", async (_name, errorClass, answer) => {
    iterated = 0;
    await stub(answer);
    unavailable(await get(), 1, errorClass);
    expect(iterated).toBe(0);
  });

  // Review FAIL c.6969552574: plain indexing reads the item the prototype carries.
  it("a hole where Array.prototype carries a valid item", async () => {
    await stub(ok([GOOD, , GOOD]));
    await planted(Array.prototype, "1", { value: { ...GOOD } }, async () =>
      unavailable(await get(), 1, "type_error"),
    );
  });

  // QA self-check and FAIL c.6972446133 / c.6972449231: ok, value, error and
  // error.code count only as own fields of the snapshot (inherited code: 503, not 401).
  const UNAUTH = "MY_ASSIGNMENT_WORK_UNAUTHENTICATED";
  it.each([
    ["ok", { value: true }, () => ({ value: [GOOD] }), 0],
    ["value", { value: [GOOD] }, () => ({ ok: true }), 1],
    ["code", { value: UNAUTH }, () => ({ ok: false, error: {} }), 0],
    // A getter only a result with its own ok: false sees, as a plain error field breaks fetch.
    [
      "error",
      {
        get(this: object) {
          return Object.hasOwn(this, "ok") ? { code: UNAUTH } : undefined;
        },
      },
      () => ({ ok: false }),
      0,
    ],
  ] as [string, PropertyDescriptor, () => unknown, number][])(
    "a result whose %s only Object.prototype carries",
    async (key, field, answer, n) => {
      await stub(answer);
      await planted(Object.prototype, key, field, async () =>
        unavailable(await get(), n, n === 0 ? undefined : "type_error"),
      );
    },
  );

  it("fields that only Object.prototype carries", async () => {
    await stub(ok([{}]));
    await planted(Object.prototype, "assignmentId", { value: A1 }, () =>
      planted(Object.prototype, "workState", { value: "submitted" }, async () =>
        unavailable(await get(), 1, "type_error"),
      ),
    );
  });
});

describe("what still leaves as 200: the snapshot, exactly", () => {
  class Item {
    assignmentId = A1;
    workState = "submitted";
    toJSON() {
      return { leak: OTHER };
    }
  }
  it.each([
    ["a valid list", ok([GOOD, { assignmentId: A2, workState: "not_started" }])],
    ["an instance with own valid fields", ok([new Item()])],
    ["an extra property on the array", ok(Object.assign([GOOD], { extra: OTHER }))],
    ["an extra property on the result", () => ({ ok: true, value: [GOOD], extra: OTHER })],
    [
      "an own iterator over valid items",
      ok(
        Object.assign([GOOD], {
          *[Symbol.iterator]() {
            yield BAD;
          },
        }),
      ),
    ],
  ] as [string, () => unknown][])("%s", async (name, answer) => {
    await stub(answer);
    const got = await get();
    const two = name === "a valid list" ? [{ assignmentId: A2, workState: "not_started" }] : [];
    expect([got.status, got.body]).toEqual([200, { assignments: [GOOD, ...two] }]);
    expect(lines).toEqual([]);
  });
});

// QA FAIL c.6973700421 (#317): JSON.stringify in writeJson reads an inherited toJSON on
// every object of the 200 body; what leaves is still exactly the checked snapshot. Each
// planted toJSON touches only its target, so fetch and the report spy stay intact.
describe("an inherited toJSON never changes the 200 body", () => {
  const FORGED = [{ ...BAD, studentId: OTHER }];
  const has = (o: unknown, key: string) =>
    typeof o === "object" && o !== null && Object.hasOwn(o, key);
  const list = (o: unknown) => Array.isArray(o) && has(o[0], "assignmentId");
  // One forged value per target; an item gets one forged item, so its own fields are
  // never a target again (toJSON is called once per value, never on what it returns).
  const forging = (
    target: (o: unknown) => boolean,
    forged: unknown = FORGED,
  ): PropertyDescriptor => ({
    value(this: unknown) {
      return target(this) ? forged : this;
    },
  });
  it.each([
    ["Array.prototype.toJSON on the list", Array.prototype, forging(list)],
    [
      "Object.prototype.toJSON on an item",
      Object.prototype,
      forging((o) => has(o, "assignmentId"), FORGED[0]),
    ],
    [
      "Object.prototype.toJSON on the body",
      Object.prototype,
      forging((o) => has(o, "assignments")),
    ],
    [
      "a throwing toJSON getter on Array.prototype",
      Array.prototype,
      {
        get(this: unknown) {
          if (list(this)) throw new TypeError("tajna");
          return undefined;
        },
      },
    ],
    [
      "a toJSON getter on Object.prototype for the list",
      Object.prototype,
      {
        get(this: unknown) {
          return list(this) ? () => FORGED : undefined;
        },
      },
    ],
  ] as [string, object, PropertyDescriptor][])("%s", async (_name, proto, field) => {
    await stub(ok([GOOD]));
    let got: Answer | undefined;
    await planted(proto, "toJSON", field, async () => {
      got = await get();
    });
    expect([got!.status, got!.body]).toEqual([200, { assignments: [GOOD] }]);
    expect(lines).toEqual([]);
  });
});

describe("the reader's own answers", () => {
  const code = (c: string) => () => ({ ok: false, error: { code: c, messageKey: "x.y" } });
  it("UNAUTHENTICATED is 401", async () => {
    await stub(code("MY_ASSIGNMENT_WORK_UNAUTHENTICATED"));
    expect([(await get()).status, tokens]).toEqual([401, [TOKEN]]);
  });
  it.each([
    ["MY_ASSIGNMENT_WORK_ROW_MALFORMED", code("MY_ASSIGNMENT_WORK_ROW_MALFORMED")],
    ["MY_ASSIGNMENT_WORK_DATABASE_ERROR", code("MY_ASSIGNMENT_WORK_DATABASE_ERROR")],
    ["an unknown code", code("ELSE")],
    ["ok false without an error", () => ({ ok: false })],
    ["ok that is only truthy", () => ({ ok: "yes", value: [GOOD] })],
    ["a string result", () => "ok"],
    ["a null result", () => null],
    ["a number result", () => 7],
  ] as [string, () => unknown][])("%s is 503 without a report", async (_name, answer) => {
    await stub(answer);
    unavailable(await get(), 0);
  });
  it("a reader that throws is 503 with one report", async () => {
    await stub(() => {
      throw new Error("tajna");
    });
    unavailable(await get(), 1, "other");
  });
});

describe("who asks comes only from one live session cookie", () => {
  it.each([
    ["no cookie", null],
    ["a short token", `__Host-ductus_session=${TOKEN.slice(1)}`],
    ["two session cookies", `${COOKIE}; __Host-ductus_session=${OTHER}`],
    ["an ended session", `${COOKIE}; ductus-ended-${sessionTag(TOKEN)!}=1`],
    ["another name", `ductus_session=${OTHER}`],
    ["only a query and a header", null, `?studentId=${OTHER}`, { "x-student-id": OTHER }],
  ] as [string, string | null, string?, Record<string, string>?][])(
    "%s: 401, the reader is never asked",
    async (_name, cookie, query, extra) => {
      await stub(ok([GOOD]));
      expect((await get(cookie, query, extra)).body.code).toBe("unauthorized");
      expect(tokens).toEqual([]);
    },
  );
  it("a query, a header and other cookies do not choose who asks", async () => {
    await stub(ok([GOOD]));
    const cookie = `ductus_session=${OTHER}; ${COOKIE}`;
    expect((await get(cookie, `?studentId=${OTHER}`, { "x-student-id": OTHER })).status).toBe(200);
    expect(tokens).toEqual([TOKEN]);
  });
});

describe("the production route over withActor: the contract's vectors", () => {
  const row = (id: string, document: string | null, revision: number | null) =>
    Object.fromEntries([
      ["assignment_id", id],
      ["document_id", document],
      ["submitted_revision", revision],
    ]);
  const ANSWERS: Record<string, unknown> = {
    ready: ["01", "02", "03"].map((n, i) =>
      row(
        `1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e${n}`,
        i === 1 ? null : "izmisljeni-dokument-0001",
        i === 2 ? 2 : null,
      ),
    ),
    "ready-empty": [],
    unavailable: Object.assign(new Error("tajna"), { code: "57P01" }),
  };
  it.each(VECTORS.map((v) => [v.name, v] as const))("%s", async (name, v) => {
    const answer = ANSWERS[name] ?? [];
    const withActor = (async (token, fn) => {
      tokens.push(token);
      return fn({
        async query() {
          if (answer instanceof Error) throw answer;
          return { rows: answer as never[], rowCount: 0 };
        },
      });
    }) as WithActor;
    await serve(createStudentAssignmentWorkRouteFor({ withActor }));
    const got = await get(v.request.headers?.cookie ?? null);
    expect(got.headers.get("cache-control")).toBe("no-store");
    expect(got.headers.get("set-cookie")).toBeNull();
    const requestId = got.headers.get("x-request-id");
    expect([got.status, got.body]).toEqual([
      v.response.status,
      got.status === 200 ? v.response.body : { ...v.response.body, requestId },
    ]);
  });
});
