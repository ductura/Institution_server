// DAN-851-1c2 (contract Ductus#1836 c.6936456136, amended c.6938415428): the
// profile service hands the port only a valid UTF-8, canonical JSON body with
// exactly one valid locale; every other body is refused before the port.
// Every token and value below is invented.
import { readFileSync } from "node:fs";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { AppError, InterfaceLocale, Result } from "../domain/index.ts";
import type { InterfaceLocaleStore } from "../database/index.ts";

import {
  createProfileService,
  INTERFACE_LOCALE_INVALID_BODY,
  INTERFACE_LOCALE_INVALID_JSON,
  PROFILE_ERRORS,
} from "./service.ts";

const TOKEN = "izmisljeni-token-profila-00000000000000001";
const DB_ERROR: AppError = { code: "INTERFACE_LOCALE_DATABASE_ERROR", messageKey: "x.y" };

function fake(answer?: Result<InterfaceLocale>) {
  const calls = { save: [] as unknown[][], read: [] as unknown[][] };
  const read: Result<InterfaceLocale | null> = { ok: true, value: "hr" };
  const store: InterfaceLocaleStore = {
    read: async (...args) => {
      calls.read.push(args);
      return read;
    },
    save: async (token, locale) => {
      calls.save.push([token, locale]);
      return answer ?? { ok: true, value: locale };
    },
  };
  return { service: createProfileService({ store }), calls, read };
}

const bytes = (text: string) => new TextEncoder().encode(text);
const fail = (error: AppError) => ({ ok: false, error });

afterEach(() => vi.restoreAllMocks());

async function refused(input: Uint8Array, error: AppError) {
  const { service, calls } = fake();
  expect(await service.saveInterfaceLocale(TOKEN, input)).toEqual(fail(error));
  expect(calls.save).toEqual([]);
}

describe("profile service errors (docs/CODE_STYLE.md §8)", () => {
  const catalogue: unknown = JSON.parse(
    readFileSync(new URL("../../locales/hr.json", import.meta.url), "utf8"),
  );
  const lookup = (key: string): unknown =>
    key
      .split(".")
      .reduce<unknown>(
        (node, part) =>
          node && typeof node === "object" ? (node as Record<string, unknown>)[part] : undefined,
        catalogue,
      );

  it("has a Croatian text for every messageKey and distinct UPPER_SNAKE codes", () => {
    expect(PROFILE_ERRORS).toHaveLength(2);
    for (const error of PROFILE_ERRORS) {
      const text = lookup(error.messageKey);
      expect(typeof text === "string" && text.trim().length > 0, error.messageKey).toBe(true);
      expect(error.code).toMatch(/^INTERFACE_LOCALE_[A-Z]+(?:_[A-Z]+)*$/);
    }
    expect(new Set(PROFILE_ERRORS.map((e) => e.code)).size).toBe(2);
  });
});

describe("saveInterfaceLocale refuses before the port", () => {
  it.each([
    ["empty body", bytes("")],
    ["unquoted key", bytes('{locale:"hr"}')],
    ["unterminated", bytes('{"locale":"hr"')],
    ["invalid UTF-8", Uint8Array.of(0x7b, 0xff, 0x7d)],
    ["encoded lone surrogate", Uint8Array.of(0x22, 0xed, 0xa0, 0x80, 0x22)],
    ["byte order mark", bytes('﻿{"locale":"hr"}')],
    ["NBSP outside a string", bytes('{"locale":"hr"} ')],
    ["DEL outside a string", bytes('\u007f{"locale":"hr"}')],
  ])("%s is invalid JSON", async (_name, input) => {
    await refused(input, INTERFACE_LOCALE_INVALID_JSON);
  });

  it.each([
    ["space after colon", '{"locale": "hr"}'],
    ["space before key", '{ "locale":"hr"}'],
    ["trailing LF", '{"locale":"hr"}\n'],
    ["CRLF", '{"locale":"hr"}\r\n'],
    ["tab", '{"locale":\t"hr"}'],
    ["escape", '{"locale":"h\\u0072"}'],
    ["duplicate, last en", '{"locale":"hr","locale":"en"}'],
    ["duplicate, last hr", '{"locale":"de","locale":"hr"}'],
  ])("not canonical: %s", async (_name, text) => {
    await refused(bytes(text), INTERFACE_LOCALE_INVALID_BODY);
  });

  const deep = '{"locale":' + "[".repeat(300) + "]".repeat(300) + "}";
  it.each([
    ["infinite number", '{"locale":1e400}'],
    ["nesting deeper than 256", deep],
    ["escaped lone surrogate value", '{"locale":"\\ud800"}'],
    ["escaped lone surrogate key", '{"\\ud800":"hr"}'],
  ])("canonicalizeJcs throws: %s", async (_name, text) => {
    await refused(bytes(text), INTERFACE_LOCALE_INVALID_BODY);
  });

  it.each([
    "{}",
    '{"language":"en"}',
    '{"locale":"hr","userId":"00000000-0000-4000-8000-000000000001"}',
    '{"institutionId":"x","locale":"hr"}',
    '{"locale":"hr","sub":"x"}',
    '{"locale":"hr","workLanguage":"en"}',
    '{"locale":"hr","x":1}',
    '{"__proto__":"hr"}',
    '{"toString":"hr"}',
    '{"locale":"HR"}',
    '{"locale":"de"}',
    '{"locale":"en-GB"}',
    '{"locale":""}',
    '{"locale":" hr"}',
    '{"locale":"hr "}',
    '{"locale":null}',
    '{"locale":1}',
    '{"locale":["hr"]}',
    '{"locale":{"value":"hr"}}',
    '"hr"',
    "[]",
    "null",
  ])("the domain refuses %s", async (text) => {
    await refused(bytes(text), INTERFACE_LOCALE_INVALID_BODY);
  });
});

describe("saveInterfaceLocale and readInterfaceLocale over the port", () => {
  it.each([
    fail({ code: "INTERFACE_LOCALE_INVALID", messageKey: "a.b" }),
    fail({ code: "INTERFACE_LOCALE_UNAUTHENTICATED", messageKey: "a.c" }),
    fail(DB_ERROR),
  ] as Result<InterfaceLocale>[])(
    "passes the port's outcome %j through as the same object",
    async (answer) => {
      const { service } = fake(answer);
      expect(await service.saveInterfaceLocale(TOKEN, bytes('{"locale":"en"}'))).toBe(answer);
    },
  );

  it.each(["hr", "en"] as const)("saves %s with one port call and the token", async (locale) => {
    const { service, calls } = fake();
    const saved = await service.saveInterfaceLocale(TOKEN, bytes(`{"locale":"${locale}"}`));
    expect(saved).toEqual({ ok: true, value: locale });
    expect(calls.save).toEqual([[TOKEN, locale]]);
  });

  it("reads through the port once and returns its outcome as the same object", async () => {
    const { service, calls, read } = fake();
    expect(await service.readInterfaceLocale(TOKEN)).toBe(read);
    expect(calls.read).toEqual([[TOKEN]]);
  });

  it("logs nothing", async () => {
    const spies = ["error", "warn", "log", "info"].map((m) => vi.spyOn(console, m as "error"));
    const { service } = fake();
    await service.saveInterfaceLocale(TOKEN, bytes("{"));
    await service.saveInterfaceLocale(TOKEN, bytes('{"locale":"de"}'));
    await service.saveInterfaceLocale(TOKEN, bytes('{"locale":"hr"}'));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});
