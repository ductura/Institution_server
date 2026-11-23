// The restore record port over a fake withActor: the one statement and its
// parameters, the outcomes, the refusals and every malformed answer. Every
// value is invented.
import { describe, expect, it } from "vitest";

import { RESTORE_MAX_FROM_REVISION } from "../../contracts/index.ts";
import type { ActorTransaction, WithActor } from "../index.ts";

import { createRevisionRestore, RESTORE_MAX_FROM } from "./index.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const DOCUMENT = "izmisljeni-rad-0001";
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });

function fake(answer: unknown[] | Error) {
  const seen: { token: unknown; sql: string; values: readonly unknown[] }[] = [];
  const withActor = (async (token, fn) =>
    fn({
      async query(sql: string, values: readonly unknown[] = []) {
        seen.push({ token, sql, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer };
      },
    } as unknown as ActorTransaction)) as WithActor;
  return { record: createRevisionRestore(withActor), seen };
}

describe("createRevisionRestore", () => {
  it("calls app.record_revision_restore once with the work and the revision", async () => {
    const { record, seen } = fake([{ outcome: "recorded", revision: "3" }]);
    expect(await record(TOKEN, DOCUMENT, 2)).toEqual({
      status: "ok",
      outcome: "recorded",
      revision: 3,
    });
    expect(seen).toEqual([
      {
        token: TOKEN,
        sql: "SELECT outcome, revision::text AS revision FROM app.record_revision_restore($1, $2::bigint)",
        values: [DOCUMENT, 2],
      },
    ]);
  });

  it("answers already_recorded with the revision it names", async () => {
    expect(
      await fake([{ outcome: "already_recorded", revision: "9007199254740991" }]).record(
        TOKEN,
        DOCUMENT,
        1,
      ),
    ).toEqual({ status: "ok", outcome: "already_recorded", revision: Number.MAX_SAFE_INTEGER });
  });

  it("answers no_matching_revision without a revision", async () => {
    expect(
      await fake([{ outcome: "no_matching_revision", revision: null }]).record(TOKEN, DOCUMENT, 1),
    ).toEqual({ status: "ok", outcome: "no_matching_revision" });
  });

  it("answers not_found for the one not_found row", async () => {
    expect(
      await fake([{ outcome: "not_found", revision: null }]).record(TOKEN, DOCUMENT, 1),
    ).toEqual({
      status: "not_found",
    });
  });

  it.each([
    ["no session", "ZD401", "unauthenticated"],
    ["a revision out of range", "ZD422", "invalid"],
  ])("maps %s to %s", async (_name, code, status) => {
    expect(await fake(coded(code)).record(TOKEN, DOCUMENT, 1)).toEqual({ status });
  });

  it.each([
    ["any other code", coded("XX000")],
    ["an error without a code", new Error("izmišljeno")],
  ])("answers unavailable for %s", async (_name, error) => {
    expect(await fake(error).record(TOKEN, DOCUMENT, 1)).toEqual({ status: "unavailable" });
  });

  it.each([
    ["no row", []],
    [
      "two rows",
      [
        { outcome: "recorded", revision: "3" },
        { outcome: "recorded", revision: "4" },
      ],
    ],
    ["an unknown outcome", [{ outcome: "restored", revision: "3" }]],
    ["an outcome that is not text", [{ outcome: 1, revision: "3" }]],
    ["recorded without a revision", [{ outcome: "recorded", revision: null }]],
    ["already_recorded without a revision", [{ outcome: "already_recorded", revision: null }]],
    ["a revision that is a number, not text", [{ outcome: "recorded", revision: 3 }]],
    ["a revision with a sign", [{ outcome: "recorded", revision: "+3" }]],
    ["a revision of zero", [{ outcome: "recorded", revision: "0" }]],
    ["a revision past the safe integers", [{ outcome: "recorded", revision: "9007199254740992" }]],
    ["the revision restored from", [{ outcome: "recorded", revision: "1" }]],
    ["no_matching_revision with a revision", [{ outcome: "no_matching_revision", revision: "3" }]],
    ["not_found with a revision", [{ outcome: "not_found", revision: "3" }]],
    ["a row without the revision column", [{ outcome: "no_matching_revision" }]],
  ])("answers unavailable for %s", async (_name, rows) => {
    expect(await fake(rows).record(TOKEN, DOCUMENT, 1)).toEqual({ status: "unavailable" });
  });

  it.each([0, -1, 1.5, Number.NaN, RESTORE_MAX_FROM + 1])(
    "refuses revision %s without a query",
    async (from) => {
      const { record, seen } = fake([{ outcome: "recorded" }]);
      expect(await record(TOKEN, DOCUMENT, from)).toEqual({ status: "invalid" });
      expect(seen).toEqual([]);
    },
  );

  it("bounds the revision as the contract does", () => {
    expect(RESTORE_MAX_FROM).toBe(RESTORE_MAX_FROM_REVISION);
    expect(RESTORE_MAX_FROM).toBe(9_007_199_254_740_990);
  });
});
