// DAN-851-1a: the interface language setting body, ported from Ductus
// src/domain/profile/interface-locale-setting.test.ts at 51a062e (DAN-427), with
// the classes of input of the contract (Ductus#1836 c.6935562064). The Ductus
// comparison with the interface catalogues imports @/lib/i18n, which
// server/domain may not; it is in tests/contracts/interface-locale-domain.test.ts.
import { describe, expect, it } from "vitest";

import {
  INTERFACE_LOCALE_SETTING_VALUES,
  parseInterfaceLocaleSetting,
} from "./interface-locale-setting.ts";

describe("parseInterfaceLocaleSetting", () => {
  it.each([
    ["upper case", "HR"],
    ["mixed case", "En"],
    ["region", "hr-HR"],
    ["underscore region", "en_GB"],
    ["unknown language", "de"],
    ["unknown tag", "xx"],
    ["empty", ""],
    ["leading space", " hr"],
    ["trailing newline", "hr\n"],
    ["CRLF", "hr\r\n"],
    ["tab", "\thr"],
    ["no-break space", "hr "],
    ["DEL", "hr\u007f"],
    ["byte order mark", "﻿hr"],
    ["Cyrillic look-alike", "һr"],
    ["full width", "ｈｒ"],
    ["too long", "hr".repeat(100)],
    ["zero width", "h​r"],
    ["toString", "toString"],
    ["__proto__", "__proto__"],
    ["constructor", "constructor"],
  ])("refuses a string outside the set: %s", (_name, locale) => {
    expect(parseInterfaceLocaleSetting({ locale })).toBeNull();
  });

  it.each([
    ["number", 1],
    ["null", null],
    ["boolean", true],
    ["array", ["hr"]],
    ["object", { value: "hr" }],
    ["undefined", undefined],
    ["object with toString", { toString: () => "hr" }],
    ["boxed string", new String("hr")],
  ])("refuses a value that is not a string: %s", (_name, locale) => {
    expect(parseInterfaceLocaleSetting({ locale })).toBeNull();
  });

  it.each([
    ["missing key", {}],
    ["extra key", { locale: "hr", userId: "00000000-0000-4000-8000-000000000001" }],
    ["institution key", { locale: "en", institutionId: "x" }],
    ["wrong key", { language: "hr" }],
    ["own __proto__ key", JSON.parse('{"locale":"hr","__proto__":{"locale":"en"}}') as unknown],
    ["only __proto__ key", JSON.parse('{"__proto__":"hr"}') as unknown],
    ["constructor key", { locale: "hr", constructor: "x" }],
    ["toString key", { toString: "hr" }],
    ["symbol key", { locale: "hr", [Symbol("extra")]: 1 }],
    ["non-enumerable key", Object.defineProperty({ locale: "hr" }, "extra", { value: 1 })],
  ])("refuses a body with other keys: %s", (_name, body) => {
    expect(parseInterfaceLocaleSetting(body)).toBeNull();
  });

  it.each([
    ["null", null],
    ["string", "hr"],
    ["number", 0],
    ["array", [{ locale: "hr" }]],
    ["undefined", undefined],
  ])("refuses a body that is not a plain object: %s", (_name, body) => {
    expect(parseInterfaceLocaleSetting(body)).toBeNull();
  });

  it("refuses an object with an inherited locale", () => {
    expect(parseInterfaceLocaleSetting(Object.create({ locale: "hr" }))).toBeNull();
  });

  it("accepts a null-prototype record and refuses a class instance", () => {
    const body = Object.assign(Object.create(null) as object, { locale: "hr" });
    expect(parseInterfaceLocaleSetting(body)).toEqual({ locale: "hr" });
    class Box {
      locale = "hr";
    }
    expect(parseInterfaceLocaleSetting(new Box())).toBeNull();
  });

  it.each([
    ["hr", "hr"],
    ["en", "en"],
  ])("accepts exactly %j", (locale, expected) => {
    expect(parseInterfaceLocaleSetting({ locale })).toEqual({ locale: expected });
  });

  it("is the closed, frozen set hr and en", () => {
    expect(INTERFACE_LOCALE_SETTING_VALUES).toEqual(["hr", "en"]);
    expect(Object.isFrozen(INTERFACE_LOCALE_SETTING_VALUES)).toBe(true);
  });
});
