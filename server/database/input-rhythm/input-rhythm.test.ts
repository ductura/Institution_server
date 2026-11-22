// SRV-0910: the port of the rhythm of typing over a fake withActor, and the
// guard of P-1 rule 4: nothing here, in the contract of the composition or in
// the SQL, holds a key or a measure derived from the gaps. All values are
// invented.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createInputRhythm, RHYTHM_MAX_GAPS_PER_BURST } from "./index.ts";

const TOKEN = "izmisljeni-token-studenta-0000000000000001";
const ID = "00000000-0000-4000-8000-0000000000c1";

function port(answer: unknown) {
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { port: createInputRhythm(withActor), seen };
}
const rowOf = (gaps: unknown, at: unknown) =>
  Object.fromEntries([
    ["id", ID],
    ["gaps_ms", gaps],
    ["recorded_at", at],
  ]);
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });

describe("input rhythm port", () => {
  it("records a burst and reports whether the switch let it through", async () => {
    const on = port([{ recorded: true }]);
    expect(await on.port.record(TOKEN, "izmisljeni-rad-0001", [120, 80])).toEqual({
      status: "ok",
      recorded: true,
    });
    expect(on.seen[0]!.values).toEqual(["izmisljeni-rad-0001", [120, 80]]);
    const off = port([{ recorded: false }]);
    expect(await off.port.record(TOKEN, "izmisljeni-rad-0001", [5])).toEqual({
      status: "ok",
      recorded: false,
    });
  });

  it("reads bursts as gaps and a time, nothing more", async () => {
    const at = new Date("2026-11-21T09:15:00.000Z");
    const { port: rhythm } = port([rowOf([10, 20], at)]);
    expect(await rhythm.read(TOKEN, "izmisljeni-rad-0001")).toEqual({
      status: "ok",
      bursts: [{ id: ID, gapsMs: [10, 20], recordedAt: at.toISOString() }],
    });
    const tooLong = port([rowOf(Array(RHYTHM_MAX_GAPS_PER_BURST + 1).fill(1), at)]);
    expect(await tooLong.port.read(TOKEN, "izmisljeni-rad-0001")).toEqual({
      status: "unavailable",
    });
  });

  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD422", "invalid"],
    ["XX000", "unavailable"],
  ])("maps %s to %s", async (code, status) => {
    const { port: rhythm } = port(sqlError(code));
    expect(await rhythm.remove(TOKEN, "izmisljeni-rad-0001")).toEqual({ status });
    expect(await rhythm.setEnabled(TOKEN, false)).toEqual({ status });
  });

  it("deletes on request and counts what went", async () => {
    const { port: rhythm } = port([{ deleted: 3 }]);
    expect(await rhythm.remove(TOKEN, "izmisljeni-rad-0001")).toEqual({
      status: "ok",
      deleted: 3,
    });
  });
});

describe("no key and no derived measure of speed (P-1 rule 4)", () => {
  const FORBIDDEN =
    /key(code|stroke|name)?\b|keys\b|speed|wpm|cpm|average|mean\b|median|rate\b|velocity|profile|typing_?speed|stddev|variance/i;

  it("the SQL of the class computes no average, spread or speed and names no key", () => {
    const sql = readFileSync(
      new URL("../../../db/main/migrations/20261213100300_origin_kind_rhythm.sql", import.meta.url),
      "utf8",
    )
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("--"))
      .join("\n");
    expect(sql).not.toMatch(/\b(avg|percentile_\w+|stddev\w*|variance|corr)\s*\(/i);
    expect(sql).not.toMatch(/key_?code|keystroke|\bkey_?name\b|speed/i);
  });

  it("the rhythm table and the port carry gaps and bookkeeping only", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
      .split("\n")
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n");
    expect(source).not.toMatch(/\b(reduce|average|mean|sum)\b/i);
  });
});
