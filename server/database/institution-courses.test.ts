// DAN-852-2a (contract Ductus#1836 c.6943486866): the enrollment code leaves
// the port only with exactly one row of the code's form; every refusal or
// fault has no code, no message and no SQLSTATE of the database, a malformed
// row rolls the transaction back, and the port never throws. Every token,
// identifier and message below is invented.
import { describe, expect, it } from "vitest";

import { createInstitutionCourses } from "./institution-courses.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-upisa-00000000000000000001";
const COURSE = "00000000-0000-4000-8000-000000000852";
const UNTIL = "2026-12-01T10:00:00.123456+01:00";
const ISSUE_SQL = "SELECT institution.create_enrollment_code($1, $2::timestamptz) AS code";
const SECRET = "tajna poruka baze s izmisljenim SQL-om";
const GOOD = "A1B2-C3D4-E5F6-0789";

type Answer = {
  rows?: unknown;
  throws?: unknown;
  actorThrows?: unknown;
  actorThrowsSync?: unknown;
};

/** A fake withActor that, like the real one, throws on whatever fn throws. */
function port(answer: Answer) {
  const calls = {
    queries: [] as { text: string; values: unknown; token: string }[],
    fnRejected: 0,
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
        return await fn(tx);
      } catch (error) {
        calls.fnRejected += 1;
        throw error;
      }
    })();
  }) as WithActor;
  return { courses: createInstitutionCourses(withActor), calls };
}

const issue = (answer: Answer) => {
  const p = port(answer);
  return { result: p.courses.issueEnrollmentCode(TOKEN, COURSE, UNTIL), calls: p.calls };
};
const dbError = (code: unknown) => Object.assign(new Error(SECRET), { code });
const DATABASE = { status: "unavailable", reason: "database_error" };
const MALFORMED = { status: "unavailable", reason: "issue_malformed" };

/** No message, SQLSTATE or code of the database in what leaves the port. */
function expectNothingLeaks(outcome: unknown) {
  const text = JSON.stringify(outcome);
  expect(text).not.toContain(SECRET);
  expect(text).not.toMatch(/ZD|[0-9A-F]{4}-[0-9A-F]{4}/);
  expect(Object.keys(outcome as object).sort()).toEqual(
    "reason" in (outcome as object) ? ["reason", "status"] : ["status"],
  );
}

describe("issueEnrollmentCode refusals of the database", () => {
  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "forbidden"],
    ["ZD422", "invalid"],
  ])("%s is %s", async (code, status) => {
    const outcome = await issue({ throws: dbError(code) }).result;
    expect(outcome).toEqual({ status });
    expectNothingLeaks(outcome);
  });

  const getter = Object.defineProperty({}, "code", {
    get() {
      throw new Error(SECRET);
    },
  });
  it.each([
    ["ZD409 (only for a course)", dbError("ZD409")],
    ["ZD500", dbError("ZD500")],
    ["ZD503", dbError("ZD503")],
    ["unique violation 23505", dbError("23505")],
    ["bad uuid 22P02", dbError("22P02")],
    ["bad time 22007", dbError("22007")],
    ["time out of range 22008", dbError("22008")],
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
          has() {
            throw new Error(SECRET);
          },
        },
      ),
    ],
  ])("%s is unavailable without detail", async (_name, thrown) => {
    const outcome = await issue({ throws: thrown }).result;
    expect(outcome).toEqual(DATABASE);
    expectNothingLeaks(outcome);
  });

  it("withActor that rejects or throws synchronously is unavailable", async () => {
    for (const answer of [
      { actorThrows: new Error(SECRET) },
      { actorThrowsSync: new Error(SECRET) },
    ]) {
      const { result, calls } = issue(answer);
      expect(await result).toEqual(DATABASE);
      expect(calls.queries).toHaveLength(0);
    }
  });

  it("ZD401 of withActor itself (a dead session) is unauthenticated, as in Ductus", async () => {
    expect(await issue({ actorThrows: dbError("ZD401") }).result).toEqual({
      status: "unauthenticated",
    });
  });
});

describe("issueEnrollmentCode rows of a wrong form", () => {
  it.each([
    ["no rows", []],
    ["two rows", [{ code: GOOD }, { code: GOOD }]],
    ["rows that are not an array", { code: GOOD }],
    ["undefined rows", undefined],
    ["a null row", [null]],
    ["a row without the column", [{ other: GOOD }]],
    ["an inherited column", [Object.create({ code: GOOD }) as object]],
    ["lower case", [{ code: GOOD.toLowerCase() }]],
    ["no dashes", [{ code: GOOD.replaceAll("-", "") }]],
    ["five groups", [{ code: `${GOOD}-ABCD` }]],
    ["three groups", [{ code: "A1B2-C3D4-E5F6" }]],
    ["a letter outside hex", [{ code: "G1B2-C3D4-E5F6-0789" }]],
    ["a trailing LF", [{ code: `${GOOD}\n` }]],
    ["a trailing CRLF", [{ code: `${GOOD}\r\n` }]],
    ["a trailing tab", [{ code: `${GOOD}\t` }]],
    ["a trailing NBSP", [{ code: `${GOOD} ` }]],
    ["a trailing DEL", [{ code: `${GOOD}\u007F` }]],
    ["full-width digits", [{ code: "１２３４-C3D4-E5F6-0789" }]],
    ["a number", [{ code: 1234 }]],
    ["a null code", [{ code: null }]],
  ])("%s is issue_malformed and rolls back", async (_name, rows) => {
    const { result, calls } = issue({ rows });
    const outcome = await result;
    expect(outcome).toEqual(MALFORMED);
    expectNothingLeaks(outcome);
    expect(calls.fnRejected).toBe(1);
  });
});

describe("issueEnrollmentCode success", () => {
  it("returns the one code with the exact statement and parameters", async () => {
    const { result, calls } = issue({ rows: [{ code: GOOD }] });
    expect(await result).toEqual({ status: "issued", code: GOOD });
    expect(calls.queries).toEqual([{ text: ISSUE_SQL, values: [COURSE, UNTIL], token: TOKEN }]);
    expect(calls.fnRejected).toBe(0);
  });
});

// DAN-852-2b: createCourse and revokeEnrollmentCode over the same call.
const COURSE_SQL = "SELECT institution.create_course($1, $2, $3) AS id";
const REVOKE_SQL = "SELECT institution.revoke_enrollment_code($1) AS revoked";
const BODY = {
  name: "Izmišljeni kolegij",
  academicYear: "2026/2027",
  aiPolicy: "encouraged",
} as const;
const NEW_ID = "0000000a-000b-4000-8000-0000000000cd";

const create = (answer: Answer) => {
  const p = port(answer);
  return { result: p.courses.createCourse(TOKEN, BODY), calls: p.calls };
};
const revoke = (answer: Answer) => {
  const p = port(answer);
  return { result: p.courses.revokeEnrollmentCode(TOKEN, COURSE), calls: p.calls };
};
const OUTSIDE = [
  dbError("ZD500"),
  dbError("23505"),
  dbError("22P02"),
  new Error(SECRET),
  null,
  SECRET,
];

describe("createCourse", () => {
  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "forbidden"],
    ["ZD409", "conflict"],
    ["ZD422", "invalid"],
  ])("%s is %s", async (code, status) => {
    const outcome = await create({ throws: dbError(code) }).result;
    expect(outcome).toEqual({ status });
    expectNothingLeaks(outcome);
  });

  it.each(OUTSIDE.map((thrown) => [String(thrown), thrown]))(
    "%s is unavailable without detail",
    async (_name, thrown) => {
      const outcome = await create({ throws: thrown }).result;
      expect(outcome).toEqual(DATABASE);
      expectNothingLeaks(outcome);
    },
  );

  it.each([
    ["no rows", []],
    ["two rows", [{ id: NEW_ID }, { id: NEW_ID }]],
    ["a null row", [null]],
    ["an inherited id", [Object.create({ id: NEW_ID }) as object]],
    ["a trailing LF", [{ id: `${NEW_ID}\n` }]],
    ["a trailing NBSP", [{ id: `${NEW_ID} ` }]],
    ["no dashes", [{ id: NEW_ID.replaceAll("-", "") }]],
    ["a letter outside hex", [{ id: NEW_ID.replace("a", "g") }]],
    ["a number", [{ id: 852 }]],
    ["a null id", [{ id: null }]],
  ])("%s is create_malformed and rolls back", async (_name, rows) => {
    const { result, calls } = create({ rows });
    expect(await result).toEqual({ status: "unavailable", reason: "create_malformed" });
    expect(calls.fnRejected).toBe(1);
  });

  it("returns the id, also in upper case, with the exact statement and parameters", async () => {
    for (const id of [NEW_ID, NEW_ID.toUpperCase()]) {
      const { result, calls } = create({ rows: [{ id }] });
      expect(await result).toEqual({ status: "created", id });
      expect(calls.queries).toEqual([
        { text: COURSE_SQL, values: [BODY.name, BODY.academicYear, BODY.aiPolicy], token: TOKEN },
      ]);
    }
  });
});

describe("revokeEnrollmentCode", () => {
  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "forbidden"],
  ])("%s is %s", async (code, status) => {
    expect(await revoke({ throws: dbError(code) }).result).toEqual({ status });
  });

  it.each(
    [...OUTSIDE, dbError("ZD409"), dbError("ZD422")].map((thrown) => [String(thrown), thrown]),
  )("%s (ZD409 and ZD422 included) is unavailable without detail", async (_name, thrown) => {
    const outcome = await revoke({ throws: thrown }).result;
    expect(outcome).toEqual(DATABASE);
    expectNothingLeaks(outcome);
  });

  it.each([
    ["no rows", []],
    ["two rows", [{ revoked: true }, { revoked: true }]],
    ["an inherited column", [Object.create({ revoked: true }) as object]],
    ["the string true", [{ revoked: "true" }]],
    ["the number 1", [{ revoked: 1 }]],
    ["null", [{ revoked: null }]],
  ])("%s is revoke_malformed and rolls back", async (_name, rows) => {
    const { result, calls } = revoke({ rows });
    expect(await result).toEqual({ status: "unavailable", reason: "revoke_malformed" });
    expect(calls.fnRejected).toBe(1);
  });

  it.each([true, false])("returns revoked %s with the exact statement", async (revoked) => {
    const { result, calls } = revoke({ rows: [{ revoked }] });
    expect(await result).toEqual({ status: "revoked", revoked });
    expect(calls.queries).toEqual([{ text: REVOKE_SQL, values: [COURSE], token: TOKEN }]);
  });
});
