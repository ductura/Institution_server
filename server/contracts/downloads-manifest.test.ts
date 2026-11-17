// DAN-931 (S-1H.5, Ductus#1836 UGOVOR w931a): the download manifest as a
// contract and vectors only; the handler is DAN-932. Every case is a closed
// table over the 200 body, the refusals first.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { VECTORS } from "./generated/fake-server/index.ts";
import { ROUTES } from "./index.ts";

const ID = "downloads.manifest.get";
const route = ROUTES.find((r) => r.id === ID);
const body = route?.responses[0]?.body;
const SHA = "0123456789abcdef".repeat(4);
const URL_OK = "https://preuzimanje.example.invalid/ductura/1.0.0/ductura-windows-x64.msi";
const row = { system: "windows", architecture: "x64", version: "1.0.0", url: URL_OK, sha256: SHA };
const list = (...rows: unknown[]) => ({ packages: rows });
// No route, no pass: a missing body throws instead of refusing everything.
const check = (value: unknown) => {
  if (body === undefined) throw new Error(`${ID} has no 200 body`);
  return Value.Check(body, value);
};
const accepts = (field: string, value: unknown) => check(list({ ...row, [field]: value }));
const TAILS = ["\n", "\r\n", "\r", "\t", " ", "\u00a0", "\u007f", "\u0000"];

describe("downloads.manifest.get refuses", () => {
  it.each([
    "",
    SHA.slice(1),
    `${SHA}0`,
    SHA.toUpperCase(),
    `${SHA.slice(1)}g`,
    ` ${SHA.slice(1)}`,
    ...TAILS.map((tail) => `${SHA}${tail}`),
    ...TAILS.map((tail) => `${tail}${SHA}`),
  ])("the sha256 %j", (sha256) => expect(accepts("sha256", sha256)).toBe(false));

  it.each(["linux", "ios", "android", "Windows", "MACOS", "win32", "darwin", "macOS", ""])(
    "the system %j",
    (system) => expect(accepts("system", system)).toBe(false),
  );

  it.each(["x86", "ia32", "aarch64", "ARM64", "amd64", "X64", "arm", ""])(
    "the architecture %j",
    (architecture) => expect(accepts("architecture", architecture)).toBe(false),
  );

  it.each(TAILS.flatMap((tail) => [`windows${tail}`, `${tail}macos`, `arm64${tail}`]))(
    "a system or architecture with %j around it",
    (value) => expect(accepts("system", value) || accepts("architecture", value)).toBe(false),
  );

  it.each(["1.0", "1.0.0.0", "01.0.0", "1.00.0", "1.0.0-beta", "1.0.0+1", "v1.0.0", "", "1.0.0\n"])(
    "the version %j",
    (version) => expect(accepts("version", version)).toBe(false),
  );

  it.each([
    "http://preuzimanje.example.invalid/a.msi",
    "ftp://preuzimanje.example.invalid/a.msi",
    "//preuzimanje.example.invalid/a.msi",
    "javascript:alert(1)",
    "file:///C:/a.msi",
    "C:\\Downloads\\a.msi",
    "\\\\host.invalid\\share\\a.msi",
    "/preuzimanje\\a.msi",
    "preuzimanje/a.msi",
    "https://PREUZIMANJE.example.invalid/a.msi",
    "https://user@preuzimanje.example.invalid/a.msi",
    "https://preuzimanje.example.invalid",
    "https://preuzimanje.example.invalid/a.msi#x",
    "https:///a.msi",
    "https://-a.invalid/a.msi",
    "/preuzimanje/a%2.msi",
    "/preuzimanje/a%zz.msi",
    '/preuzimanje/"a".msi',
    "/preuzimanje/<a>.msi",
    "/preuzimanje/a b.msi",
    "/preuzimanje/č.msi",
    "/preuzimanje/../a.msi",
    "/preuzimanje/./a.msi",
    "/preuzimanje/..",
    "/preuzimanje/.?x=1",
    "/%2e%2e/a.msi",
    "/preuzimanje/%2E/a.msi",
    "/preuzimanje/a%2emsi",
    "/preuzimanje/a%00.msi",
    "https://preuzimanje.example.invalid:8443/a.msi",
    "https://localhost/a.msi",
    "https://127.0.0.1/a.msi",
    "https://preuzimanje.example.invalid./a.msi",
    "",
    "/",
    `/${"a".repeat(2048)}`,
    ...TAILS.map((tail) => `${URL_OK}${tail}`),
    ...TAILS.map((tail) => `/preuzimanje/a${tail}b.msi`),
  ])("the url %j", (url) => expect(accepts("url", url)).toBe(false));

  it.each([null, 1, true, [SHA], { value: SHA }])("a field of type %j", (value) => {
    for (const field of Object.keys(row)) expect(accepts(field, value)).toBe(false);
  });

  it.each(Object.keys(row))("a row without %s", (key) => {
    const partial: Record<string, unknown> = { ...row };
    delete partial[key];
    expect(check(list(partial))).toBe(false);
  });

  it.each(["__proto__", "toString", "constructor", "size", "signature", "publishedAt"])(
    "an own key %s on the row and on the answer",
    (key) => {
      const extra = JSON.parse(`{"${key}": 1}`) as object;
      expect(check(list({ ...row, ...extra }))).toBe(false);
      expect(check({ ...list(row), ...extra })).toBe(false);
    },
  );

  it("five rows, and an answer that is not a list of rows", () => {
    expect(check(list(row, row, row, row, row))).toBe(false);
    for (const value of [null, [], {}, { packages: null }, { packages: [null] }, [row]])
      expect(check(value)).toBe(false);
  });
});

describe("downloads.manifest.get accepts", () => {
  it("each system and architecture, both url forms, the longest url and an empty list", () => {
    for (const system of ["windows", "macos"])
      for (const architecture of ["x64", "arm64"])
        expect(check(list({ ...row, system, architecture }))).toBe(true);
    for (const url of [
      "/preuzimanje/ductura/1.0.0/ductura-macos-arm64.dmg",
      "https://preuzimanje.example.invalid/a.msi?v=1&x=%2F",
      "/preuzimanje/.well/a..b.msi",
      `/${"a".repeat(2047)}`,
    ])
      expect(accepts("url", url)).toBe(true);
    expect(accepts("version", "10.20.30")).toBe(true);
    expect(check(list(row, row, row, row))).toBe(true);
    expect(check(list())).toBe(true);
  });

  it("is a public GET with no input that fails only as unavailable", () => {
    expect(route?.method).toBe("GET");
    expect(route?.path).toBe("/api/v1/downloads/manifest");
    expect(route?.access).toBe("anyone");
    expect(route?.request).toEqual({});
    expect(route?.responses.map((r) => r.status)).toEqual([200]);
    expect(route?.errors.map((e) => `${e.status} ${e.code}`)).toEqual(["503 unavailable"]);
  });

  it("has vectors for all four packages, none, and 503; each pair at most once", () => {
    const own = VECTORS.filter((v) => v.route === ID);
    expect(own.map((v) => `${v.name} ${v.response.status}`)).toEqual([
      "ready 200",
      "ready-empty 200",
      "unavailable 503",
    ]);
    const ready = own[0]?.response.body as
      { packages: { system: string; architecture: string }[] } | undefined;
    const pairs = ready?.packages.map((p) => `${p.system} ${p.architecture}`) ?? [];
    expect(pairs).toEqual(["macos arm64", "macos x64", "windows arm64", "windows x64"]);
  });
});
