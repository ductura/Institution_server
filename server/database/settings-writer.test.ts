// DAN-826-2a (S-1J-g; contract Ductus#1836 c.6935304942): the adapter of
// settings.set_value maps the database's own refusals to outcomes, rethrows
// every other error, and refuses a row of an unexpected form. All values are
// invented.
import { describe, expect, it } from "vitest";

import { createSettingsWriter, type SettingWriteInput } from "./settings-writer.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "A".repeat(43);
const WRITE: SettingWriteInput = {
  level: "personal",
  course: null,
  key: "notifications.email",
  value: false,
  bound: null,
};

function writer(answer: () => Promise<Record<string, unknown>[]>) {
  const seen: { token: unknown; text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ token, text, values });
        const rows = await answer();
        return { rows: rows as never[], rowCount: rows.length };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { seen, writer: createSettingsWriter(withActor) };
}
const rows =
  (...list: Record<string, unknown>[]) =>
  () =>
    Promise.resolve(list);
const fails = (error: unknown) => () => Promise.reject(error);

describe("createSettingsWriter refusals", () => {
  it.each([
    ["ZD401", "unauthenticated"],
    ["ZD403", "not_found"],
    ["ZD409", "bound_crossed"],
    ["ZD422", "invalid"],
  ])("%s is %s", async (code, status) => {
    const error = Object.assign(new Error("izmišljena poruka baze"), { code });
    expect(await writer(fails(error)).writer.setValue(TOKEN, WRITE)).toEqual({ status });
  });

  it.each([
    ["another SQLSTATE", Object.assign(new Error("x"), { code: "ZD500" })],
    ["a connection fault", Object.assign(new Error("x"), { code: "ECONNREFUSED" })],
    ["no code", new Error("x")],
    ["a code that is not a string", Object.assign(new Error("x"), { code: 403 })],
    ["not an Error", "ZD403"],
    ["null", null],
  ])("%s is thrown again, unchanged", async (_name, error) => {
    await expect(writer(fails(error)).writer.setValue(TOKEN, WRITE)).rejects.toBe(error);
  });

  it.each([
    ["no row", []],
    ["two rows", [{ change: "1" }, { change: "2" }]],
    ["no change column", [{ id: "1" }]],
    ["a change that is not an integer", [{ change: "1.5" }]],
    ["a negative change", [{ change: "-1" }]],
    ["a change as a boolean", [{ change: true }]],
  ])("%s is unavailable set_malformed", async (_name, list) => {
    const outcome = await writer(rows(...(list as Record<string, unknown>[]))).writer.setValue(
      TOKEN,
      WRITE,
    );
    expect(outcome).toEqual({ status: "unavailable", reason: "set_malformed" });
  });
});

describe("createSettingsWriter writes", () => {
  it("one call is one statement with five parameters, under the caller's token", async () => {
    const { seen, writer: w } = writer(rows({ change: "7" }));
    expect(await w.setValue(TOKEN, WRITE)).toEqual({
      status: "saved",
      key: "notifications.email",
      value: false,
      bound: null,
      changed: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.token).toBe(TOKEN);
    expect(seen[0]!.text).toMatch(
      /^SELECT settings\.set_value\(\$1, \$2::uuid, \$3, \$4::jsonb, \$5::jsonb\)/u,
    );
    expect(seen[0]!.values).toEqual(["personal", null, "notifications.email", "false", null]);
  });

  it("a NULL change is saved without a change", async () => {
    const outcome = await writer(rows({ change: null })).writer.setValue(TOKEN, WRITE);
    expect(outcome).toMatchObject({ status: "saved", changed: false });
  });

  it.each([
    ["a string that reads as a boolean", "true", '"true"'],
    ["an integer", 60, "60"],
    ["a string with a quote", 'a"b', '"a\\"b"'],
    ["no value", null, null],
  ])("value %s goes as JSON text", async (_name, value, text) => {
    const { seen, writer: w } = writer(rows({ change: "1" }));
    await w.setValue(TOKEN, { ...WRITE, value });
    expect(seen[0]!.values?.[3]).toBe(text);
  });

  it("the bound and course go as given", async () => {
    const course = "0b5c1d2e-3f40-4a51-8b62-7c83d94e0a1f";
    const { seen, writer: w } = writer(rows({ change: "1" }));
    const outcome = await w.setValue(TOKEN, {
      level: "network_security",
      course: null,
      key: "network.session_idle_minutes",
      value: 60,
      bound: { min: 30, max: 90 },
    });
    expect(seen[0]!.values).toEqual([
      "network_security",
      null,
      "network.session_idle_minutes",
      "60",
      '{"min":30,"max":90}',
    ]);
    expect(outcome).toMatchObject({ bound: { min: 30, max: 90 }, changed: true });
    await w.setValue(TOKEN, { ...WRITE, level: "course", course, bound: { locked: true } });
    expect(seen[1]!.values?.[1]).toBe(course);
    expect(seen[1]!.values?.[4]).toBe('{"locked":true}');
  });
});
