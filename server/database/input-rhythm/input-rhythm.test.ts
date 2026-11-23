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
    expect(await rhythm.setEnabled(TOKEN, ID, false)).toEqual({ status });
    expect(await rhythm.readEnabled(TOKEN, ID)).toEqual({ status });
    expect(await rhythm.state(TOKEN, "izmisljeni-rad-0001")).toEqual({ status });
    expect(await rhythm.clearEnabled(TOKEN, ID)).toEqual({ status });
    expect(await rhythm.setCourseEnabled(TOKEN, ID, false)).toEqual({ status });
    expect(await rhythm.readCourseEnabled(TOKEN, ID)).toEqual({ status });
  });

  it("the switch answers the state, who changed it last and when", async () => {
    const at = new Date("2026-11-22T09:15:00.000Z");
    const row = (role: unknown, name: unknown, when: unknown, source: unknown = "assignment") =>
      Object.fromEntries([
        ["enabled", false],
        ["source", source],
        ["changed_by_role", role],
        ["changed_by_name", name],
        ["changed_at", when],
      ]);
    const set = port([row("teacher", "Izmišljena Nastavnica", at)]);
    expect(await set.port.setEnabled(TOKEN, ID, false)).toEqual({
      status: "ok",
      enabled: false,
      source: "assignment",
      changedBy: { role: "teacher", name: "Izmišljena Nastavnica" },
      changedAt: at.toISOString(),
    });
    expect(set.seen[0]!.text).toContain("app.input_rhythm_switch(");
    expect(set.seen[0]!.values).toEqual([ID, false]);
    const read = port([row("mentor", null, at)]);
    expect(await read.port.readEnabled(TOKEN, ID)).toEqual({
      status: "ok",
      enabled: false,
      source: "assignment",
      changedBy: { role: "mentor", name: null },
      changedAt: at.toISOString(),
    });
    expect(read.seen[0]!.text).toContain("app.input_rhythm_switch_read(");
    const state = port([{ ...row(null, null, null, "default"), enabled: true }]);
    expect(await state.port.state(TOKEN, "izmisljeni-rad-0001")).toEqual({
      status: "ok",
      enabled: true,
      source: "default",
      changedBy: null,
      changedAt: null,
    });
    expect(state.seen[0]!.values).toEqual(["izmisljeni-rad-0001"]);
    for (const bad of [
      { ...row(null, null, null, "default"), enabled: "da" },
      row(null, null, null),
      row(null, null, null, "default"),
      row("teacher", null, at, "default"),
      row("teacher", null, at, "student"),
      row("teacher", null, at, null),
      row("student", null, at),
      row("teacher", null, null),
      row("teacher", 7, at),
    ]) {
      expect(await port([bad]).port.state(TOKEN, "x")).toEqual({ status: "unavailable" });
    }
    expect(await port([]).port.readEnabled(TOKEN, ID)).toEqual({ status: "unavailable" });
  });

  it("the course's switch and the clearing call their RPCs and answer the source", async () => {
    const at = new Date("2026-11-23T09:15:00.000Z");
    const course = Object.fromEntries([
      ["enabled", false],
      ["source", "course"],
      ["changed_by_role", "teacher"],
      ["changed_by_name", null],
      ["changed_at", at],
    ]);
    const expected = {
      status: "ok",
      enabled: false,
      source: "course",
      changedBy: { role: "teacher", name: null },
      changedAt: at.toISOString(),
    };
    const set = port([course]);
    expect(await set.port.setCourseEnabled(TOKEN, ID, false)).toEqual(expected);
    expect(set.seen[0]!.text).toContain("app.input_rhythm_course_switch(");
    expect(set.seen[0]!.values).toEqual([ID, false]);
    const read = port([course]);
    expect(await read.port.readCourseEnabled(TOKEN, ID)).toEqual(expected);
    expect(read.seen[0]!.text).toContain("app.input_rhythm_course_switch_read(");
    const clear = port([course]);
    expect(await clear.port.clearEnabled(TOKEN, ID)).toEqual(expected);
    expect(clear.seen[0]!.text).toContain("app.input_rhythm_switch_clear(");
    expect(clear.seen[0]!.values).toEqual([ID]);
  });

  it("the student's own switch is never called", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/app\.input_rhythm_set\(/);
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

  it.each([
    "20261213100300_origin_kind_rhythm.sql",
    "20261213110100_input_rhythm_teacher_switch.sql",
  ])("the SQL of %s computes no average, spread or speed and names no key", (file) => {
    const sql = readFileSync(
      new URL(`../../../db/main/migrations/${file}`, import.meta.url),
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
