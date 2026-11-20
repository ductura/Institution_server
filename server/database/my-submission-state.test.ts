// SRV-22 (Ductus#2028 c.7009405737): the caller's own submission state and
// word range of one assignment, from app.my_submission_state() and
// app.my_assignment_requirements() (SRV-20). Who asks comes only from the
// token inside withActor; a row the port cannot vouch for is row_malformed.
// Negative cases first. Every token, id and text below is invented.
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  createMySubmissionStateReader,
  MY_SUBMISSION_STATE_DATABASE_ERROR,
  MY_SUBMISSION_STATE_ERRORS,
  MY_SUBMISSION_STATE_NOT_FOUND,
  MY_SUBMISSION_STATE_ROW_MALFORMED,
  MY_SUBMISSION_STATE_UNAUTHENTICATED,
} from "./my-submission-state.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-stanja-predaje-00000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const AT = "2026-12-20T21:14:05.123456Z";
const DIGEST = "c".repeat(64);
const SIGNATURE = { algorithm: "Ed25519" };
// The columns as the driver names them; built from entries, as they are no camelCase names.
const stateRow = (
  state: unknown,
  revision: unknown = null,
  requestedAt: unknown = null,
  payload: unknown = null,
  digest: unknown = null,
  signature: unknown = null,
): object =>
  Object.fromEntries([
    ["state", state],
    ["revision", revision],
    ["requested_at", requestedAt],
    ["receipt_payload", payload],
    ["payload_digest_sha256", digest],
    ["signature", signature],
  ]);
const rangeRow = (outcome: unknown, min: unknown = null, max: unknown = null): object =>
  Object.fromEntries([
    ["outcome", outcome],
    ["word_min", min],
    ["word_max", max],
  ]);

function reader(answer: unknown) {
  const seen: { token: unknown; text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ token, text, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { port: createMySubmissionStateReader(withActor), seen };
}

const fail = (error: unknown) => ({ ok: false, error });
const sqlError = (code: unknown) => Object.assign(new Error("tekst greške baze"), { code });

describe("my submission state errors (docs/CODE_STYLE.md §8)", () => {
  const catalogue = JSON.parse(
    readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
  ) as { mySubmissionState?: Record<string, unknown> };
  it("has a Croatian text for every key, and no other key in its section", () => {
    const section = catalogue.mySubmissionState ?? {};
    for (const { messageKey } of MY_SUBMISSION_STATE_ERRORS) {
      const [area, key] = messageKey.split(".");
      expect(area).toBe("mySubmissionState");
      expect(typeof section[key!]).toBe("string");
    }
    expect(Object.keys(section).sort()).toEqual(
      MY_SUBMISSION_STATE_ERRORS.map((e) => e.messageKey.split(".")[1]).sort(),
    );
  });
});

describe("before the database", () => {
  it("a missing or malformed token is unauthenticated and sends nothing", async () => {
    const { port, seen } = reader([stateRow("none")]);
    for (const token of [undefined, "", "kratki", `${TOKEN}=`]) {
      expect(await port.state(token, A)).toEqual(fail(MY_SUBMISSION_STATE_UNAUTHENTICATED));
      expect(await port.requirements(token, A)).toEqual(fail(MY_SUBMISSION_STATE_UNAUTHENTICATED));
    }
    expect(seen).toEqual([]);
  });

  it("an id that is not a lower-case uuid is not_found and sends nothing", async () => {
    const { port, seen } = reader([stateRow("none")]);
    for (const id of ["", "nije-uuid", A.toUpperCase(), ` ${A}`, `${A}\n`]) {
      expect(await port.state(TOKEN, id)).toEqual(fail(MY_SUBMISSION_STATE_NOT_FOUND));
      expect(await port.requirements(TOKEN, id)).toEqual(fail(MY_SUBMISSION_STATE_NOT_FOUND));
    }
    expect(seen).toEqual([]);
  });
});

describe("database errors", () => {
  it("ZD401 is unauthenticated; any other error, or none, is database_error", async () => {
    expect(await reader(sqlError("ZD401")).port.state(TOKEN, A)).toEqual(
      fail(MY_SUBMISSION_STATE_UNAUTHENTICATED),
    );
    for (const code of ["ZD403", "57014", 401, undefined]) {
      expect(await reader(sqlError(code)).port.requirements(TOKEN, A)).toEqual(
        fail(MY_SUBMISSION_STATE_DATABASE_ERROR),
      );
    }
    const getter = Object.defineProperty(new Error("x"), "code", {
      get() {
        throw new Error("getter");
      },
    });
    expect(await reader(getter).port.state(TOKEN, A)).toEqual(
      fail(MY_SUBMISSION_STATE_DATABASE_ERROR),
    );
  });
});

describe("the state row", () => {
  it("sends the id once, as a parameter, under the caller's token", async () => {
    const { port, seen } = reader([stateRow("none")]);
    expect(await port.state(TOKEN, A)).toEqual({ ok: true, value: { state: "none" } });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.token).toBe(TOKEN);
    expect(seen[0]!.values).toEqual([A]);
    expect(seen[0]!.text).toContain("app.my_submission_state($1::uuid)");
    expect(seen[0]!.text).not.toContain(A);
  });

  it("reads not_found, ceka and potvrdeno", async () => {
    expect(await reader([stateRow("not_found")]).port.state(TOKEN, A)).toEqual(
      fail(MY_SUBMISSION_STATE_NOT_FOUND),
    );
    expect(await reader([stateRow("ceka", "7", AT)]).port.state(TOKEN, A)).toEqual({
      ok: true,
      value: { state: "ceka", revision: 7, requestedAt: AT },
    });
    const bound = stateRow("potvrdeno", "7", AT, '{"a":1}', DIGEST, SIGNATURE);
    expect(await reader([bound]).port.state(TOKEN, A)).toEqual({
      ok: true,
      value: {
        state: "potvrdeno",
        revision: 7,
        receiptPayload: '{"a":1}',
        payloadDigestSha256: DIGEST,
        signature: SIGNATURE,
      },
    });
  });

  it.each([
    ["no row", []],
    ["two rows", [stateRow("none"), stateRow("none")]],
    ["not an array", { rows: [] }],
    ["an unknown state", [stateRow("submitted")]],
    ["none with a revision", [stateRow("none", "1")]],
    ["none with a receipt", [stateRow("none", null, null, "{}", DIGEST, SIGNATURE)]],
    ["not_found with an instant", [stateRow("not_found", null, AT)]],
    ["ceka without a revision", [stateRow("ceka", null, AT)]],
    ["ceka with revision 0", [stateRow("ceka", "0", AT)]],
    ["ceka with a numeric revision", [stateRow("ceka", 7, AT)]],
    ["ceka with an unsafe revision", [stateRow("ceka", "9007199254740993", AT)]],
    ["ceka with a millisecond instant", [stateRow("ceka", "7", "2026-12-20T21:14:05.123Z")]],
    ["ceka with a Date", [stateRow("ceka", "7", new Date(AT))]],
    ["ceka with a receipt", [stateRow("ceka", "7", AT, "{}", DIGEST, SIGNATURE)]],
    ["potvrdeno without a payload", [stateRow("potvrdeno", "7", AT, null, DIGEST, SIGNATURE)]],
    ["potvrdeno with a short digest", [stateRow("potvrdeno", "7", AT, "{}", "c", SIGNATURE)]],
    ["potvrdeno without a signature", [stateRow("potvrdeno", "7", AT, "{}", DIGEST, null)]],
    ["potvrdeno with a text signature", [stateRow("potvrdeno", "7", AT, "{}", DIGEST, "x")]],
    ["an inherited state", [Object.create(stateRow("none"))]],
  ])("%s is row_malformed", async (_name, rows) => {
    expect(await reader(rows).port.state(TOKEN, A)).toEqual(
      fail(MY_SUBMISSION_STATE_ROW_MALFORMED),
    );
  });
});

describe("the requirements row", () => {
  it("sends the id once, as a parameter, and reads the bounds", async () => {
    const { port, seen } = reader([rangeRow("found", 800, 1200)]);
    expect(await port.requirements(TOKEN, A)).toEqual({
      ok: true,
      value: { wordMin: 800, wordMax: 1200 },
    });
    expect(seen[0]!.values).toEqual([A]);
    expect(seen[0]!.text).toContain("app.my_assignment_requirements($1::uuid)");
    for (const [min, max] of [
      [null, null],
      [800, null],
      [null, 1200],
      [1, 1],
      [1_000_000, 1_000_000],
    ]) {
      expect(await reader([rangeRow("found", min, max)]).port.requirements(TOKEN, A)).toEqual({
        ok: true,
        value: { wordMin: min, wordMax: max },
      });
    }
  });

  it("reads not_found", async () => {
    expect(await reader([rangeRow("not_found")]).port.requirements(TOKEN, A)).toEqual(
      fail(MY_SUBMISSION_STATE_NOT_FOUND),
    );
  });

  it.each([
    ["no row", []],
    ["two rows", [rangeRow("found"), rangeRow("found")]],
    ["an unknown outcome", [rangeRow("ok")]],
    ["not_found with a bound", [rangeRow("not_found", 1)]],
    ["min above max", [rangeRow("found", 1201, 1200)]],
    ["a zero bound", [rangeRow("found", 0, 10)]],
    ["a bound over a million", [rangeRow("found", null, 1_000_001)]],
    ["a fractional bound", [rangeRow("found", 1.5, null)]],
    ["a text bound", [rangeRow("found", "800", null)]],
    ["a missing column", [Object.fromEntries([["outcome", "found"]])]],
  ])("%s is row_malformed", async (_name, rows) => {
    expect(await reader(rows).port.requirements(TOKEN, A)).toEqual(
      fail(MY_SUBMISSION_STATE_ROW_MALFORMED),
    );
  });
});

// SRV-30: one student's state for a reader of that student's work, from
// app.teacher_submission_state(); the same row checks as the student's read.
describe("teacherState", () => {
  const S = "00000000-0000-4000-8000-0000000000e1";

  it("sends both ids and reads the same state row", async () => {
    const { port, seen } = reader([stateRow("ceka", "4", AT)]);
    expect(await port.teacherState(TOKEN, A, S)).toEqual({
      ok: true,
      value: { state: "ceka", revision: 4, requestedAt: AT },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toContain("app.teacher_submission_state($1::uuid, $2::uuid)");
    expect(seen[0]!.values).toEqual([A, S]);
  });

  it("ZD403, the read's answer for every refusal, is not_found; ZD401 stays unauthenticated", async () => {
    expect(await reader(sqlError("ZD403")).port.teacherState(TOKEN, A, S)).toEqual(
      fail(MY_SUBMISSION_STATE_NOT_FOUND),
    );
    expect(await reader(sqlError("ZD401")).port.teacherState(TOKEN, A, S)).toEqual(
      fail(MY_SUBMISSION_STATE_UNAUTHENTICATED),
    );
    expect(await reader(sqlError("57014")).port.teacherState(TOKEN, A, S)).toEqual(
      fail(MY_SUBMISSION_STATE_DATABASE_ERROR),
    );
  });

  it("a malformed student id is not_found and never sent", async () => {
    const { port, seen } = reader([stateRow("none")]);
    expect(await port.teacherState(TOKEN, A, "nije-uuid")).toEqual(
      fail(MY_SUBMISSION_STATE_NOT_FOUND),
    );
    expect(seen).toEqual([]);
  });
});
