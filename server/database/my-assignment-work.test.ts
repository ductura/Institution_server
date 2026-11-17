// DAN-989-2a (contract Ductus#1836 c.6957393091): the state of the student's own
// work per assignment, from the rows of app.student_workspace(). Who asks comes
// only from the token inside withActor; one row the port cannot vouch for makes
// the whole answer row_malformed. Negative cases first. Every token and id below
// is invented.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createMyAssignmentWorkReader,
  MY_ASSIGNMENT_WORK_DATABASE_ERROR,
  MY_ASSIGNMENT_WORK_ERRORS,
  MY_ASSIGNMENT_WORK_ROW_MALFORMED,
  MY_ASSIGNMENT_WORK_UNAUTHENTICATED,
} from "./my-assignment-work.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-stanja-rada-00000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const B = "00000000-0000-4000-8000-0000000000b2";
const C = "00000000-0000-4000-8000-0000000000c3";
// The columns as the driver names them; built from entries, as they are no camelCase names.
const row = (id: unknown, document: unknown = null, revision: unknown = null): object =>
  Object.fromEntries([
    ["assignment_id", id],
    ["document_id", document],
    ["submitted_revision", revision],
  ]);

function reader(answer: unknown) {
  const seen: { token: unknown; text: string; values: readonly unknown[] | undefined }[] = [];
  let transactions = 0;
  const withActor = (async (token, fn) => {
    transactions += 1;
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ token, text, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { work: createMyAssignmentWorkReader(withActor), seen, transactions: () => transactions };
}

const fail = (error: unknown) => ({ ok: false, error });
const UNAUTHENTICATED = fail(MY_ASSIGNMENT_WORK_UNAUTHENTICATED);
const MALFORMED = fail(MY_ASSIGNMENT_WORK_ROW_MALFORMED);
const DATABASE_ERROR = fail(MY_ASSIGNMENT_WORK_DATABASE_ERROR);
const sqlError = (code: unknown) => Object.assign(new Error("tekst greške baze"), { code });

describe("my assignment work errors (docs/CODE_STYLE.md §8)", () => {
  const catalogue = JSON.parse(
    readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
  ) as { myAssignmentWork?: Record<string, unknown> };
  it("has a Croatian text for every key, and no other key in its section", () => {
    const section = catalogue.myAssignmentWork ?? {};
    for (const { messageKey } of MY_ASSIGNMENT_WORK_ERRORS) {
      const text = section[messageKey.replace(/^myAssignmentWork\./, "")];
      expect(typeof text === "string" && text.trim().length > 0, messageKey).toBe(true);
    }
    expect(
      Object.keys(section)
        .map((k) => `myAssignmentWork.${k}`)
        .sort(),
    ).toEqual(MY_ASSIGNMENT_WORK_ERRORS.map((e) => e.messageKey).sort());
  });

  it("lists three errors with distinct UPPER_SNAKE codes", () => {
    expect(new Set(MY_ASSIGNMENT_WORK_ERRORS.map((e) => e.code)).size).toBe(3);
    for (const { code } of MY_ASSIGNMENT_WORK_ERRORS)
      expect(code).toMatch(/^MY_ASSIGNMENT_WORK_[A-Z_]+$/);
  });
});

describe("my assignment work: refusals", () => {
  it.each<[string, string | undefined]>([
    ["missing", undefined],
    ["empty", ""],
    ["42 characters", TOKEN.slice(1)],
    ["44 characters", `${TOKEN}A`],
    ["trailing CRLF", `${TOKEN}\r\n`],
    ["trailing LF", `${TOKEN}\n`],
    ["tab", `${TOKEN.slice(1)}\t`],
    ["NBSP", `${TOKEN.slice(1)} `],
    ["DEL", `${TOKEN.slice(1)}\u007f`],
    ["U+2028", `${TOKEN.slice(1)} `],
    ["U+2029", `${TOKEN.slice(1)} `],
    ["padding", `${TOKEN.slice(1)}=`],
  ])("refuses a token that is %s before the database", async (_name, token) => {
    const r = reader([row(A)]);
    expect(await r.work.read(token)).toEqual(UNAUTHENTICATED);
    expect(r.transactions()).toBe(0);
  });

  it("answers unauthenticated for ZD401", async () => {
    expect(await reader(sqlError("ZD401")).work.read(TOKEN)).toEqual(UNAUTHENTICATED);
  });

  it.each([
    ["ZD403", sqlError("ZD403")],
    ["no code", new Error("x")],
    ["a numeric code", sqlError(401)],
    [
      "a throwing code getter",
      Object.defineProperty(new Error("x"), "code", {
        get() {
          throw new Error("getter");
        },
      }),
    ],
  ])("answers database_error for %s, without the SQLSTATE", async (_name, thrown) => {
    expect(await reader(thrown).work.read(TOKEN)).toEqual(DATABASE_ERROR);
  });

  const throwing = new Proxy(
    {},
    {
      get() {
        throw new Error("proxy");
      },
      has() {
        throw new Error("proxy");
      },
      getOwnPropertyDescriptor() {
        throw new Error("proxy");
      },
    },
  );
  const inherited = Object.create(row(A)) as object;
  const ownProto = JSON.parse(
    `{"__proto__": ${JSON.stringify(row(A))}, "toString": "${A}", "document_id": null, "submitted_revision": null}`,
  ) as object;
  const bad: [string, unknown][] = [
    ["rows that are not a list", { length: 1, 0: row(A) }],
    ["a null row", [null]],
    ["a string row", [A]],
    ["a throwing Proxy row", [throwing]],
    ["only inherited columns", [inherited]],
    ["own __proto__ and toString instead of assignment_id", [ownProto]],
    ["no assignment_id", [JSON.parse('{"document_id": null, "submitted_revision": null}')]],
    ...(
      [
        null,
        42,
        A.toUpperCase(),
        A.replace(/-/g, ""),
        ` ${A}`,
        ...["\n", "\r\n", "\t", " ", "\u007f", " ", " ", " "].map((s) => A + s),
      ] as unknown[]
    ).map((id): [string, unknown] => [`assignment_id ${JSON.stringify(id)}`, [row(id)]]),
    ...(["", " d", "d ", "d\u0000", "d ", "x".repeat(257), 7, false] as unknown[]).map(
      (d): [string, unknown] => [`document_id ${JSON.stringify(d)}`, [row(A, d)]],
    ),
    ...(["0", 0, "-1", "+1", "1.0", "01", "9007199254740992", 1.5, true, ""] as unknown[]).map(
      (v): [string, unknown] => [`submitted_revision ${JSON.stringify(v)}`, [row(A, "d", v)]],
    ),
    ["a submission without a work", [row(A, null, "1")]],
    ["repeated rows with different revisions", [row(A, "d1", "1"), row(A, "d2", "2")]],
    ["repeated rows with and without a work", [row(A, "d1"), row(A)]],
  ];
  it.each(bad)("answers row_malformed for the whole list: %s", async (_name, rows) => {
    const r = reader(Array.isArray(rows) ? [row(B), ...rows] : rows);
    expect(await r.work.read(TOKEN)).toEqual(MALFORMED);
  });
});

describe("my assignment work: the state per assignment", () => {
  it("reads nothing but its one statement, with the caller's token, in one transaction", async () => {
    const r = reader([]);
    expect(await r.work.read(TOKEN)).toEqual({ ok: true, value: [] });
    expect(r.transactions()).toBe(1);
    expect(r.seen).toEqual([
      {
        token: TOKEN,
        text: "SELECT assignment_id, document_id, submitted_revision FROM app.student_workspace()",
        values: [],
      },
    ]);
  });

  it("gives one state per assignment, ordered by assignmentId", async () => {
    const astral = `${"x".repeat(255)}\u{1f4dd}`;
    const r = reader([row(C, "d3", "4"), row(B, astral), row(A), row(C, "d4", 4), row(B, "d2")]);
    expect(await r.work.read(TOKEN)).toEqual({
      ok: true,
      value: [
        { assignmentId: A, workState: "not_started" },
        { assignmentId: B, workState: "in_progress" },
        { assignmentId: C, workState: "submitted" },
      ],
    });
  });
});
