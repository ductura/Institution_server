// S-1J-f (DAN-806): the settings catalogue and its write check (PLAN, table of
// tests, "Pomoćne funkcije": katalog postavki).
import { describe, expect, it } from "vitest";

import {
  boundOfFields,
  checkSettingWrite,
  checkWriteOf,
  defaultOf,
  fitsDefinition,
  SETTING_LEVELS,
  settingOf,
  SETTINGS_CATALOGUE,
  type SettingWrite,
} from "./index.ts";

// The key check of settings.value (db/main/migrations/20261116130000_settings_levels.sql).
const DATABASE_KEY = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;

const codeOf = (write: SettingWrite): string | null => {
  const result = checkSettingWrite(write);
  return result.ok ? null : result.error.code;
};
const personal = (key: unknown, value: unknown): string | null =>
  codeOf({ level: "personal", key, value, bound: null });
const idle = (value: unknown, bound: unknown = null): string | null =>
  codeOf({ level: "network_security", key: "network.session_idle_minutes", value, bound });

describe("SETTINGS_CATALOGUE", () => {
  it("holds only keys the database takes, each once", () => {
    const keys = SETTINGS_CATALOGUE.map((definition) => definition.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      expect(key, key).toMatch(DATABASE_KEY);
      expect(key.length, key).toBeLessThanOrEqual(64);
    }
  });

  it("puts a network_security key under network., and every level is a level", () => {
    for (const definition of SETTINGS_CATALOGUE) {
      expect(definition.levels.length, definition.key).toBeGreaterThan(0);
      for (const level of definition.levels) expect(SETTING_LEVELS).toContain(level);
      if (definition.levels.includes("network_security"))
        expect(definition.key.startsWith("network."), definition.key).toBe(true);
    }
  });

  it("has a default that passes its own check at every level of the key", () => {
    for (const definition of SETTINGS_CATALOGUE) {
      expect(fitsDefinition(definition, definition.default), definition.key).toBe(true);
      for (const level of definition.levels)
        expect(codeOf({ level, key: definition.key, value: definition.default, bound: null })).toBe(
          null,
        );
    }
  });

  it("does not hold the interface language, which keeps its own route", () => {
    expect(SETTINGS_CATALOGUE.some((definition) => /locale|language/.test(definition.key))).toBe(
      false,
    );
  });

  it("is frozen", () => {
    expect(Object.isFrozen(SETTINGS_CATALOGUE)).toBe(true);
    for (const definition of SETTINGS_CATALOGUE) {
      expect(Object.isFrozen(definition)).toBe(true);
      expect(Object.isFrozen(definition.levels)).toBe(true);
      if (definition.kind === "enum") expect(Object.isFrozen(definition.values)).toBe(true);
    }
  });
});

describe("settingOf and defaultOf", () => {
  it("find a catalogue key and its default", () => {
    expect(settingOf("notifications.email")?.kind).toBe("boolean");
    expect(defaultOf("notifications.email")).toBe(true);
    expect(defaultOf("display.reduced_motion")).toBe(false);
    expect(defaultOf("network.session_idle_minutes")).toBe(120);
  });

  it.each([
    "",
    "../x",
    "NETWORK.SESSION_IDLE_MINUTES",
    "notifications.email ",
    "notifications",
    "__proto__",
    "constructor",
    "toString",
    "hasOwnProperty",
    "notifications.email\u0000",
    "notifications․email",
  ])("know no key %j", (key) => {
    expect(settingOf(key)).toBeUndefined();
    expect(defaultOf(key)).toBeUndefined();
    expect(personal(key, true)).toBe("SETTING_UNKNOWN_KEY");
  });

  it.each([undefined, null, 1, true, ["notifications.email"], { key: "notifications.email" }])(
    "take no key of another type (%j)",
    (key) => {
      expect(settingOf(key)).toBeUndefined();
      expect(personal(key, true)).toBe("SETTING_UNKNOWN_KEY");
    },
  );
});

describe("checkSettingWrite: level", () => {
  it("allows a level of the key and refuses every other", () => {
    expect(personal("notifications.email", false)).toBe(null);
    for (const level of ["course", "institution", "system", "network_security"])
      expect(codeOf({ level, key: "notifications.email", value: false, bound: null })).toBe(
        "SETTING_LEVEL_NOT_ALLOWED",
      );
    for (const level of ["personal", "course", "institution", "system"])
      expect(codeOf({ level, key: "network.session_idle_minutes", value: 60, bound: null })).toBe(
        "SETTING_LEVEL_NOT_ALLOWED",
      );
  });

  it.each([undefined, null, "", "Personal", "personal ", "global", "__proto__", 0])(
    "refuses a level that is not one (%j)",
    (level) => {
      expect(codeOf({ level, key: "notifications.email", value: true, bound: null })).toBe(
        "SETTING_LEVEL_NOT_ALLOWED",
      );
    },
  );
});

describe("checkSettingWrite: value", () => {
  it("takes the integer ends and null as removal", () => {
    expect(idle(15)).toBe(null);
    expect(idle(120)).toBe(null);
    expect(idle(60)).toBe(null);
    expect(idle(null)).toBe(null);
  });

  it.each([14, 121, 15.5, 0, -15, -0, Number.NaN, Infinity, -Infinity, 1e3, 2 ** 53])(
    "refuses the integer %d",
    (value) => {
      expect(idle(value)).toBe("SETTING_INVALID_VALUE");
    },
  );

  it.each(["30", "120", true, [60], { minutes: 60 }, undefined])(
    "refuses a non-number %j for an integer",
    (value) => {
      expect(idle(value)).toBe("SETTING_INVALID_VALUE");
    },
  );

  it.each([0, 1, "true", "false", [true], {}, undefined])("refuses %j for a boolean", (value) => {
    expect(personal("notifications.email", value)).toBe("SETTING_INVALID_VALUE");
  });

  it("takes both booleans", () => {
    expect(personal("display.reduced_motion", true)).toBe(null);
    expect(personal("display.reduced_motion", false)).toBe(null);
  });

  it("checks an enum against its values only", () => {
    const definition = {
      key: "x.y",
      levels: ["personal"],
      kind: "enum",
      default: "a",
      values: ["a", "b"],
    } as const;
    expect(fitsDefinition(definition, "b")).toBe(true);
    expect(fitsDefinition(definition, "c")).toBe(false);
    expect(fitsDefinition(definition, "A")).toBe(false);
    expect(fitsDefinition(definition, ["a"])).toBe(false);
  });
});

describe("checkSettingWrite: bound", () => {
  it("takes a bound inside the hard limits and a lock", () => {
    expect(idle(60, { min: 30, max: 90 })).toBe(null);
    expect(idle(null, { max: 60 })).toBe(null);
    expect(idle(null, { min: 15 })).toBe(null);
    expect(idle(30, { min: 30, max: 30 })).toBe(null);
    expect(idle(120, { locked: true })).toBe(null);
  });

  it.each([
    [{ min: 20, max: 10 }],
    [{ locked: false }],
    [{ locked: true, max: 60 }],
    [{ min: "30" }],
    [{ min: 14 }],
    [{ max: 121 }],
    [{ min: 30.5 }],
    [{}],
    [{ min: 30, step: 5 }],
    [[30, 60]],
    ['{"max":60}'],
    [60],
    [true],
    [Object.assign(Object.create({ min: 15 }) as object, { max: 60 })],
  ])("refuses the bound %j", (bound) => {
    expect(idle(null, bound)).toBe("SETTING_INVALID_BOUND");
  });

  it("refuses a missing bound, which is not null", () => {
    const key = "network.session_idle_minutes";
    expect(codeOf({ level: "network_security", key, value: 60, bound: undefined })).toBe(
      "SETTING_INVALID_BOUND",
    );
  });

  it("refuses an own value outside the own bound", () => {
    expect(idle(100, { max: 90 })).toBe("SETTING_INVALID_BOUND");
    expect(idle(20, { min: 30 })).toBe("SETTING_INVALID_BOUND");
  });

  it("refuses min or max for a boolean key and any bound below institution", () => {
    const write = { level: "personal", key: "notifications.email", value: true };
    expect(codeOf({ ...write, bound: { locked: true } })).toBe("SETTING_INVALID_BOUND");
    expect(codeOf({ ...write, bound: { min: 0 } })).toBe("SETTING_INVALID_BOUND");
  });
});

describe("boundOfFields", () => {
  const bound = (locked: unknown, min: unknown, max: unknown) => {
    const result = boundOfFields({ locked, min, max });
    return result.ok ? result.value : result.error.code;
  };

  it("builds a lock, a range and no bound", () => {
    expect(bound(true, null, null)).toEqual({ locked: true });
    expect(bound(false, null, null)).toBe(null);
    expect(bound(false, 30, 90)).toEqual({ min: 30, max: 90 });
    expect(bound(false, 30, null)).toEqual({ min: 30 });
    expect(bound(false, null, 90)).toEqual({ max: 90 });
  });

  it.each([
    [true, 30, null],
    [true, null, 90],
    ["true", null, null],
    [null, null, null],
    [undefined, null, null],
    [false, 30.5, null],
    [false, null, "90"],
    [false, Number.NaN, null],
    [false, null, Infinity],
    [false, undefined, null],
    [false, 2 ** 53, null],
  ])("refuses locked %j, min %j, max %j", (locked, min, max) => {
    expect(bound(locked, min, max)).toBe("SETTING_INVALID_BOUND");
  });

  it("gives a range that checkSettingWrite then checks against the key", () => {
    const result = boundOfFields({ locked: false, min: 20, max: 10 });
    expect(result.ok).toBe(true);
    const write = {
      level: "network_security",
      key: "network.session_idle_minutes",
      value: null,
      bound: result.ok ? result.value : undefined,
    };
    expect(checkSettingWrite(write).ok).toBe(false);
  });
});

describe("checkWriteOf: kinds the catalogue does not hold yet", () => {
  const flag = {
    key: "x.flag",
    levels: ["institution", "course"],
    kind: "boolean",
    default: false,
  } as const;
  const choice = {
    key: "x.choice",
    levels: ["institution"],
    kind: "enum",
    default: "a",
    values: ["a", "b"],
  } as const;
  const code = (definition: Parameters<typeof checkWriteOf>[0], write: SettingWrite) => {
    const result = checkWriteOf(definition, write);
    return result.ok ? null : result.error.code;
  };

  it("takes a lock on a boolean or enum key at a bound level", () => {
    const write = { level: "institution", key: "x.flag", value: true, bound: { locked: true } };
    expect(code(flag, write)).toBe(null);
    expect(code(flag, { ...write, value: null })).toBe(null);
    expect(code(choice, { ...write, key: "x.choice", value: "b" })).toBe(null);
  });

  it("refuses a range on a boolean or enum key, and any bound on course", () => {
    const write = { level: "institution", key: "x.flag", value: true, bound: { min: 0 } };
    expect(code(flag, write)).toBe("SETTING_INVALID_BOUND");
    expect(code(choice, { ...write, key: "x.choice", value: "a" })).toBe("SETTING_INVALID_BOUND");
    expect(code(flag, { ...write, level: "course", bound: { locked: true } })).toBe(
      "SETTING_INVALID_BOUND",
    );
  });
});

// DAN-1012-1 (Ductus#2028): backup settings, only at the system level (D-298).
// Every class of a wrong write is refused; a bound case keeps the value null,
// because the value is checked first.
describe("backup settings", () => {
  const backup = (key: unknown, value: unknown, bound: unknown = null, level: unknown = "system") =>
    codeOf({ level, key, value, bound });
  const KEYS = ["backup.enabled", "backup.interval_hours", "backup.copies"];
  const ODD = ["\t", "\r\n", "\u00a0", "\u007f", " "];

  it("are three keys, only at system, with backup off by default", () => {
    const inCatalogue = SETTINGS_CATALOGUE.filter((d) => d.key.startsWith("backup."));
    expect(inCatalogue.map((d) => d.key)).toEqual(KEYS);
    for (const definition of inCatalogue) expect(definition.levels).toEqual(["system"]);
    expect(defaultOf("backup.enabled")).toBe(false);
    expect(settingOf("backup.interval_hours")).toMatchObject({ default: 24, min: 1, max: 24 });
    expect(settingOf("backup.copies")).toMatchObject({ default: 30, min: 1, max: 30 });
    const fixed = /destination|target|bucket|storage|encrypt|cipher|cryptography/;
    expect(SETTINGS_CATALOGUE.filter((d) => fixed.test(d.key))).toEqual([]);
  });

  it.each([
    "network.backup.enabled",
    "backup",
    "backup.unknown",
    "backup.Enabled",
    "backup.enabled.",
    "backup.destination",
    "backup.encryption",
    "__proto__",
    "toString",
    "constructor",
    ...ODD.flatMap((odd) => [`backup.enabled${odd}`, `${odd}backup.enabled`]),
  ])("know no key %j", (key) => {
    expect(backup(key, false)).toBe("SETTING_UNKNOWN_KEY");
  });

  it.each([
    "personal",
    "course",
    "institution",
    "network_security",
    "system\u00a0",
    "System",
    "toString",
    null,
  ])("refuse the level %j", (level) => {
    for (const key of KEYS)
      expect(backup(key, settingOf(key)?.default, null, level)).toBe("SETTING_LEVEL_NOT_ALLOWED");
  });

  const notBoolean = [0, 1, "true", "false", "", [], {}, [true], new Boolean(true)];
  const notInteger = (max: number) => [
    0,
    max + 1,
    -0,
    1.5,
    -1,
    String(max),
    Number.NaN,
    Infinity,
    2 ** 53,
    true,
    [max],
    { value: max },
  ];
  it.each([
    ...notBoolean.map((value) => ["backup.enabled", value, typeof value] as const),
    ...notInteger(24).map((value) => ["backup.interval_hours", value, typeof value] as const),
    ...notInteger(30).map((value) => ["backup.copies", value, typeof value] as const),
  ])("refuse %s = %s (%s)", (key, value) => {
    expect(backup(key, value)).toBe("SETTING_INVALID_VALUE");
  });

  it.each([
    ["backup.enabled", { min: 1 }],
    ["backup.copies", { min: 0 }],
    ["backup.copies", { max: 31 }],
    ["backup.interval_hours", { max: 25 }],
    ["backup.copies", { min: 10, max: 5 }],
    ["backup.interval_hours", { min: 1, max: 24, step: 1 }],
    ["backup.interval_hours", { locked: false }],
    ["backup.interval_hours", { locked: true, max: 24 }],
    ["backup.interval_hours", {}],
    ["backup.interval_hours", []],
    ["backup.interval_hours", Object.assign(Object.create({ min: 1 }), { max: 24 })],
  ])("refuse the bound %s %j", (key, bound) => {
    expect(backup(key, null, bound)).toBe("SETTING_INVALID_BOUND");
  });

  it("refuse a value outside its own bound", () => {
    expect(backup("backup.copies", 20, { max: 14 })).toBe("SETTING_INVALID_BOUND");
  });

  it.each([
    ["backup.enabled", true],
    ["backup.enabled", false],
    ["backup.interval_hours", 1],
    ["backup.interval_hours", 24],
    ["backup.copies", 1],
    ["backup.copies", 30],
  ])("take %s = %s, null as removal and a lock", (key, value) => {
    expect(backup(key, value)).toBe(null);
    expect(backup(key, null)).toBe(null);
    expect(backup(key, value, { locked: true })).toBe(null);
  });

  it("take a range on a number key inside its hard limits", () => {
    expect(backup("backup.copies", 7, { min: 7, max: 30 })).toBe(null);
    expect(backup("backup.interval_hours", null, { min: 1, max: 24 })).toBe(null);
  });
});

// DAN-1060-1 (Ductus#2028): the thresholds P-01 to P-04 of Ductus DECISIONS
// ("Zadane vrijednosti pragova": thresholds are settings of the institution),
// only at the institution level; P-05 is P-02 and has no key of its own.
describe("institution thresholds", () => {
  const at = (
    key: unknown,
    value: unknown,
    level: unknown = "institution",
    bound: unknown = null,
  ) => codeOf({ level, key, value, bound });
  const LIMITS = {
    "thresholds.session_gap_minutes": { default: 30, min: 1, max: 240 },
    "thresholds.paste_event_chars": { default: 200, min: 1, max: 100_000 },
    "thresholds.teacher_refresh_minutes": { default: 5, min: 1, max: 60 },
    "thresholds.short_assignment_hours": { default: 24, min: 1, max: 168 },
  } as const;
  const KEYS = Object.keys(LIMITS) as (keyof typeof LIMITS)[];

  it("are four integer keys, only at institution, with the decided defaults", () => {
    const inCatalogue = SETTINGS_CATALOGUE.filter((d) => d.key.startsWith("thresholds."));
    expect(inCatalogue.map((d) => d.key)).toEqual(KEYS);
    for (const key of KEYS)
      expect(settingOf(key)).toEqual({
        key,
        levels: ["institution"],
        kind: "integer",
        ...LIMITS[key],
      });
    // No other key reaches the institution level.
    const atInstitution = SETTINGS_CATALOGUE.filter((d) => d.levels.includes("institution"));
    expect(atInstitution.map((d) => d.key)).toEqual(KEYS);
  });

  it.each([
    "thresholds",
    "thresholds.paste_event_chars_p05",
    "thresholds.Paste_event_chars",
    "network.thresholds.paste_event_chars",
    "thresholds.session_gap_minutes.",
    "__proto__",
    "toString",
    ...["\t", "\r\n", " ", "\u007f", " "].map((odd) => `thresholds.session_gap_minutes${odd}`),
  ])("know no key %j", (key) => {
    expect(at(key, 30)).toBe("SETTING_UNKNOWN_KEY");
  });

  it.each([
    "personal",
    "course",
    "system",
    "network_security",
    "Institution",
    "institution ",
    "toString",
    null,
  ])("refuse the level %j", (level) => {
    for (const key of KEYS)
      expect(at(key, LIMITS[key].default, level)).toBe("SETTING_LEVEL_NOT_ALLOWED");
  });

  it.each(
    KEYS.flatMap((key) =>
      [
        0,
        -1,
        LIMITS[key].max + 1,
        -0,
        1.5,
        String(LIMITS[key].default),
        Number.NaN,
        Infinity,
        true,
        [5],
        { value: 5 },
      ].map((value) => [key, value, typeof value] as const),
    ),
  )("refuse %s = %s (%s)", (key, value) => {
    expect(at(key, value)).toBe("SETTING_INVALID_VALUE");
  });

  it.each(KEYS)("take %s at both hard limits and null as removal", (key) => {
    expect(at(key, LIMITS[key].min)).toBe(null);
    expect(at(key, LIMITS[key].max)).toBe(null);
    expect(at(key, null, "institution", { locked: true })).toBe(null);
    expect(at(key, null)).toBe(null);
  });
});
