// DAN-826-1a (S-1J-g; contract Ductus#1836 c.6916711449): the settings write
// service refuses a body the contract or the catalogue does not take, with
// the catalogue's code, before the port is reached; anything else reaches
// the port once, unchanged. All values are invented.
import { describe, expect, it } from "vitest";

import type { SettingsWriteOutcome, SettingsWriter, SettingWriteInput } from "../database/index.ts";

import { createSettingsService } from "./settings-write.ts";

const TOKEN = "izmisljeni-token-postavki-000000000000000001";
const COURSE = "0b5c1d2e-3f40-4a51-8b62-7c83d94e0a1f";
const SAVED: SettingsWriteOutcome = {
  status: "saved",
  key: "notifications.email",
  value: false,
  bound: null,
  changed: true,
};

function harness() {
  const calls: { token: string; write: SettingWriteInput }[] = [];
  const writer: SettingsWriter = {
    setValue: async (token, write) => {
      calls.push({ token, write });
      return SAVED;
    },
  };
  return { calls, service: createSettingsService(writer) };
}

const body = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
  level: "personal",
  course: null,
  key: "notifications.email",
  value: false,
  locked: false,
  min: null,
  max: null,
  ...fields,
});
const idle = (fields: Record<string, unknown>) =>
  body({ level: "network_security", key: "network.session_idle_minutes", value: 60, ...fields });

async function refused(input: unknown): Promise<string> {
  const { calls, service } = harness();
  const result = await service.put(TOKEN, input);
  expect(calls).toEqual([]);
  if (result.ok) throw new Error("expected a refusal");
  expect(result.error.messageKey).toBe("errors.invalidInput");
  return result.error.code;
}

describe("createSettingsService refuses before the database", () => {
  it.each(["x.y", "constructor", "hasownproperty", "notifications.sms"])(
    "unknown key %j",
    async (key) => {
      expect(await refused(body({ key }))).toBe("SETTING_UNKNOWN_KEY");
    },
  );

  const marks = [" ", "\t", "\r\n", "\u00a0", "\u007f"];
  it.each([
    "NETWORK.X",
    "__proto__",
    "toString",
    "..\\x",
    "C:\\x",
    "",
    "a".repeat(65),
    ...marks.flatMap((m) => [`${m}notifications.email`, `notifications.email${m}`]),
    ...marks.map((m) => `notifications${m}email`),
  ])("key outside the contract %j", async (key) => {
    expect(await refused(body({ key }))).toBe("SETTING_INVALID_BODY");
  });

  it.each([
    ["boolean as text", body({ value: "true" })],
    ["boolean as number", body({ value: 0 })],
    ["under the hard minimum", idle({ value: 14, min: null, max: null })],
    ["over the hard maximum", idle({ value: 121, min: null, max: null })],
    ["negative zero", idle({ value: -0, min: null, max: null })],
    ["true for an integer", idle({ value: true, min: null, max: null })],
  ])("invalid value: %s", async (_name, input) => {
    expect(await refused(input)).toBe("SETTING_INVALID_VALUE");
  });

  it("a fraction is refused by the contract's schema", async () => {
    expect(await refused(idle({ value: 15.5, min: null, max: null }))).toBe("SETTING_INVALID_BODY");
  });

  it("a level the catalogue does not allow for the key", async () => {
    expect(await refused(body({ level: "institution" }))).toBe("SETTING_LEVEL_NOT_ALLOWED");
    expect(await refused(body({ level: "course", course: COURSE }))).toBe(
      "SETTING_LEVEL_NOT_ALLOWED",
    );
  });

  it("a course outside the course level, and the course level without one", async () => {
    expect(await refused(body({ course: COURSE }))).toBe("SETTING_COURSE_MISMATCH");
    expect(await refused(body({ level: "course", course: null }))).toBe("SETTING_COURSE_MISMATCH");
  });

  it.each([
    ["a lock with an end", idle({ locked: true, min: 20 })],
    ["min over max", idle({ min: 90, max: 30 })],
    ["an end under the hard minimum", idle({ min: 10 })],
    ["a bound at the personal level", body({ locked: true })],
    ["a value outside its own bound", idle({ value: 100, min: 30, max: 90 })],
  ])("invalid bound: %s", async (_name, input) => {
    expect(await refused(input)).toBe("SETTING_INVALID_BOUND");
  });

  it.each([
    ["an eighth key", body({ extra: 1 })],
    ["a missing key", (({ max: _max, ...rest }) => rest)(body())],
    ["__proto__ as a key", JSON.parse(`{"__proto__":1,${JSON.stringify(body()).slice(1)}`)],
    ["inherited fields", Object.create(body()) as unknown],
    ["an array", [body()]],
    ["null", null],
    ["a string", JSON.stringify(body())],
  ])("body of a wrong shape: %s", async (_name, input) => {
    expect(await refused(input)).toBe("SETTING_INVALID_BODY");
  });
});

describe("createSettingsService passes a valid write on once", () => {
  const write = (fields: Partial<SettingWriteInput>): SettingWriteInput => ({
    level: "personal",
    course: null,
    key: "notifications.email",
    value: false,
    bound: null,
    ...fields,
  });
  it.each([
    ["a personal value", body(), write({})],
    ["a removal", body({ value: null }), write({ value: null })],
    [
      "a range of the network level",
      idle({ min: 30, max: 90 }),
      write({
        level: "network_security",
        key: "network.session_idle_minutes",
        value: 60,
        bound: { min: 30, max: 90 },
      }),
    ],
    [
      "a lock of the network level",
      idle({ locked: true }),
      write({
        level: "network_security",
        key: "network.session_idle_minutes",
        value: 60,
        bound: { locked: true },
      }),
    ],
  ])("%s", async (_name, input, expected) => {
    const { calls, service } = harness();
    const result = await service.put(TOKEN, input);
    expect(result).toEqual({ ok: true, value: SAVED });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBe(TOKEN);
    expect(calls[0]?.write).toEqual(expected);
  });

  it("returns every outcome of the port unchanged", async () => {
    const outcomes: SettingsWriteOutcome[] = [
      { status: "unauthenticated" },
      { status: "not_found" },
      { status: "bound_crossed" },
      { status: "invalid" },
      { status: "unavailable", reason: "set_value_failed" },
    ];
    for (const outcome of outcomes) {
      const service = createSettingsService({ setValue: async () => outcome });
      expect(await service.put(TOKEN, body())).toEqual({ ok: true, value: outcome });
    }
  });
});

// DAN-1012-1 (Ductus#2028): a wrong backup setting never reaches the port.
// Only cases a JSON body can carry; the catalogue's own table is in
// server/domain/settings/catalogue.test.ts.
describe("backup settings at the write service", () => {
  const backup = (fields: Record<string, unknown>) =>
    body({ level: "system", key: "backup.enabled", value: true, ...fields });

  it.each([
    ["a string for a boolean", backup({ value: "true" }), "SETTING_INVALID_VALUE"],
    ["a number for a boolean", backup({ value: 1 }), "SETTING_INVALID_VALUE"],
    ["minus zero", backup({ key: "backup.copies", value: -0 }), "SETTING_INVALID_VALUE"],
    [
      "a string for hours",
      backup({ key: "backup.interval_hours", value: "24" }),
      "SETTING_INVALID_VALUE",
    ],
    [
      "more than daily",
      backup({ key: "backup.interval_hours", value: 25 }),
      "SETTING_INVALID_VALUE",
    ],
    ["more than 30 copies", backup({ key: "backup.copies", value: 31 }), "SETTING_INVALID_VALUE"],
    ["no copy", backup({ key: "backup.copies", value: 0 }), "SETTING_INVALID_VALUE"],
    ["the network level", backup({ level: "network_security" }), "SETTING_LEVEL_NOT_ALLOWED"],
    ["the institution level", backup({ level: "institution" }), "SETTING_LEVEL_NOT_ALLOWED"],
    ["the personal level", backup({ level: "personal" }), "SETTING_LEVEL_NOT_ALLOWED"],
    ["a key under network.", backup({ key: "network.backup.enabled" }), "SETTING_UNKNOWN_KEY"],
    [
      "a destination",
      backup({ key: "backup.destination", value: "elsewhere" }),
      "SETTING_UNKNOWN_KEY",
    ],
    ["a range on a boolean", backup({ value: null, min: 1 }), "SETTING_INVALID_BOUND"],
    [
      "min above max",
      backup({ key: "backup.copies", value: null, min: 9, max: 3 }),
      "SETTING_INVALID_BOUND",
    ],
    [
      "a range past 30",
      backup({ key: "backup.copies", value: null, max: 31 }),
      "SETTING_INVALID_BOUND",
    ],
    ["a key with NBSP", backup({ key: "backup.enabled " }), "SETTING_INVALID_BODY"],
    ["a key with CRLF", backup({ key: "backup.enabled\r\n" }), "SETTING_INVALID_BODY"],
    ["an extra field", backup({ destination: "elsewhere" }), "SETTING_INVALID_BODY"],
  ])("refuses %s", async (_name, input, code) => {
    expect(await refused(input)).toBe(code);
  });

  it("passes a valid backup setting to the port once", async () => {
    const { calls, service } = harness();
    const input = backup({ key: "backup.copies", value: 14, min: 7, max: 30 });
    expect(await service.put(TOKEN, input)).toEqual({ ok: true, value: SAVED });
    expect(calls.map((call) => call.write)).toEqual([
      {
        level: "system",
        course: null,
        key: "backup.copies",
        value: 14,
        bound: { min: 7, max: 30 },
      },
    ]);
  });
});
