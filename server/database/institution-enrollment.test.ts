// DAN-853-1b: the port of institution.enroll_with_code. A course id leaves
// the port only with exactly one row "enrolled" and a UUID; "refused" and
// "too_many_attempts" only with a null course. Unlike the course port, a row
// of a wrong form never rolls back: a refused guess must keep its attempt
// (Ductus enrollment-route.ts maps the row after withActor commits). Every
// refusal or fault has no message and no SQLSTATE of the database, and the
// port never throws. Every token, identifier and message below is invented.
import { describe, expect, it } from "vitest";

import { createInstitutionEnrollment } from "./institution-enrollment.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-upisa-00000000000000000001";
const CODE = "izmisljeni-kod-0001";
const COURSE = "2c1d0e9f-8a7b-4c6d-9e5f-4a3b2c1d0e01";
const SQL = "SELECT outcome, enrolled_course_id FROM institution.enroll_with_code($1::text)";
const SECRET = "tajna poruka baze s izmisljenim SQL-om";

type Answer = {
  rows?: unknown;
  throws?: unknown;
  actorThrows?: unknown;
  actorThrowsSync?: unknown;
};

/** A fake withActor that, like the real one, commits only when fn resolves and throws on whatever fn throws. */
function enroll(answer: Answer) {
  const calls = {
    queries: [] as { text: string; values: unknown; token: string }[],
    fnRejected: 0,
    committed: 0,
  };
  const withActor = ((token: string, fn: (tx: ActorTransaction) => Promise<unknown>) => {
    if ("actorThrowsSync" in answer) throw answer.actorThrowsSync;
    return (async () => {
      if ("actorThrows" in answer) throw answer.actorThrows;
      const tx = {
        async query(text: string, values?: readonly unknown[]) {
          calls.queries.push({ text, values, token });
          if ("throws" in answer) throw answer.throws;
          return { rows: answer.rows, rowCount: 0 };
        },
      } as unknown as ActorTransaction;
      try {
        const value = await fn(tx);
        calls.committed += 1;
        return value;
      } catch (error) {
        calls.fnRejected += 1;
        throw error;
      }
    })();
  }) as WithActor;
  return { result: createInstitutionEnrollment(withActor).enrollWithCode(TOKEN, CODE), calls };
}

const dbError = (code: unknown) => Object.assign(new Error(SECRET), { code });
const DATABASE = { status: "unavailable", reason: "database_error" };
const MALFORMED = { status: "unavailable", reason: "enroll_malformed" };

function expectNothingLeaks(outcome: unknown) {
  const text = JSON.stringify(outcome);
  expect(text).not.toContain(SECRET);
  expect(text).not.toMatch(/ZD|[0-9a-f]{8}-/);
}

describe("enrollWithCode refusals and faults of the database", () => {
  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "forbidden"],
  ])("%s is %s", async (code, status) => {
    const outcome = await enroll({ throws: dbError(code) }).result;
    expect(outcome).toEqual({ status });
    expectNothingLeaks(outcome);
  });

  const getter = Object.defineProperty({}, "code", {
    get() {
      throw new Error(SECRET);
    },
  });
  it.each([
    ["ZD422 (not raised by this RPC)", dbError("ZD422")],
    ["ZD409", dbError("ZD409")],
    ["ZD500 (not READ COMMITTED)", dbError("ZD500")],
    ["ZD503 (institution not configured)", dbError("ZD503")],
    ["a lock timeout 55P03", dbError("55P03")],
    ["an error without a code", new Error(SECRET)],
    ["a code that is not a string", dbError(401)],
    ["a thrown null", null],
    ["a thrown string", SECRET],
    ["a code getter that throws", getter],
    [
      "a Proxy whose has trap throws",
      new Proxy(
        {},
        {
          has: () => {
            throw new Error(SECRET);
          },
        },
      ),
    ],
  ])("%s is unavailable without detail", async (_name, thrown) => {
    const outcome = await enroll({ throws: thrown }).result;
    expect(outcome).toEqual(DATABASE);
    expectNothingLeaks(outcome);
  });

  it("withActor that rejects or throws synchronously is unavailable, with no query", async () => {
    for (const answer of [
      { actorThrows: new Error(SECRET) },
      { actorThrowsSync: new Error(SECRET) },
    ]) {
      const { result, calls } = enroll(answer);
      expect(await result).toEqual(DATABASE);
      expect(calls.queries).toHaveLength(0);
    }
  });

  it("ZD401 thrown outside fn is unauthenticated too", async () => {
    expect(await enroll({ actorThrows: dbError("ZD401") }).result).toEqual({
      status: "unauthenticated",
    });
  });
});

describe("enrollWithCode rows of a wrong form: unavailable, and nothing rolls back", () => {
  const row = (outcome: unknown, course: unknown) => ({ outcome, enrolled_course_id: course });
  it.each([
    ["no rows", []],
    ["two rows", [row("refused", null), row("refused", null)]],
    ["rows that are not an array", row("refused", null)],
    ["undefined rows", undefined],
    ["a null row", [null]],
    ["a row that is a string", ["refused"]],
    ["inherited columns", [Object.create(row("enrolled", COURSE)) as object]],
    ["enrolled without a course", [row("enrolled", null)]],
    ["enrolled with a course that is not a UUID", [row("enrolled", "x")]],
    ["enrolled with a trailing LF", [row("enrolled", `${COURSE}\n`)]],
    ["enrolled with a trailing CRLF", [row("enrolled", `${COURSE}\r\n`)]],
    ["enrolled with a trailing tab", [row("enrolled", `${COURSE}\t`)]],
    ["enrolled with a trailing NBSP", [row("enrolled", `${COURSE} `)]],
    ["enrolled with a trailing DEL", [row("enrolled", `${COURSE}\u007f`)]],
    ["enrolled with a course that is a number", [row("enrolled", 1)]],
    ["refused with a course", [row("refused", COURSE)]],
    ["refused without the column", [{ outcome: "refused" }]],
    ["too_many_attempts with a course", [row("too_many_attempts", COURSE)]],
    ["an unknown outcome", [row("toString", null)]],
    ["an outcome in upper case", [row("REFUSED", null)]],
    ["an outcome that is not a string", [row(null, null)]],
    [
      "a column getter that throws",
      [
        Object.defineProperty({ enrolled_course_id: null }, "outcome", {
          enumerable: true,
          get: () => {
            throw new Error(SECRET);
          },
        }),
      ],
    ],
    [
      "a row Proxy whose trap throws",
      [
        new Proxy(
          {},
          {
            getOwnPropertyDescriptor: () => {
              throw new Error(SECRET);
            },
          },
        ),
      ],
    ],
  ])("%s is enroll_malformed", async (_name, rows) => {
    const { result, calls } = enroll({ rows });
    const outcome = await result;
    expect(outcome).toEqual(MALFORMED);
    expectNothingLeaks(outcome);
    expect(calls.fnRejected).toBe(0);
    expect([calls.queries.length, calls.committed]).toEqual([1, 1]);
  });
});

describe("enrollWithCode outcomes", () => {
  it.each([
    ["refused", { status: "refused" }],
    ["too_many_attempts", { status: "too_many_attempts" }],
  ])("%s with a null course is %j, committed", async (outcome, expected) => {
    const { result, calls } = enroll({ rows: [{ outcome, enrolled_course_id: null }] });
    expect(await result).toEqual(expected);
    expect(calls.fnRejected).toBe(0);
    expect([calls.queries.length, calls.committed]).toEqual([1, 1]);
  });

  it.each([COURSE, COURSE.toUpperCase()])(
    "enrolled returns the course %s with the exact statement and parameter",
    async (course) => {
      const { result, calls } = enroll({
        rows: [{ outcome: "enrolled", enrolled_course_id: course }],
      });
      expect(await result).toEqual({ status: "enrolled", courseId: course });
      expect(calls.queries).toEqual([{ text: SQL, values: [CODE], token: TOKEN }]);
    },
  );
});
