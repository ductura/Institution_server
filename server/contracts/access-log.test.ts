// DAN-904: the student's own access log as a route (readMyAccessLogPage,
// Ductus#1836 c.6948327193): the parts the schema must hold beyond "every
// vector matches its schema". PRODUCT §5 rule 17, D-274 MQ10, C-23.
import { Value } from "@sinclair/typebox/value";
import { describe, expect, it } from "vitest";

import { VECTORS } from "./generated/fake-server/index.ts";
import { ROUTES } from "./index.ts";

const ID = "student.access-log.get";
const route = ROUTES.find((r) => r.id === ID);
const body = route?.responses[0]?.body;
const ROW = "6a5b4c3d-2e1f-4a0b-9c8d-7e6f5a4b3c01";
const entry = {
  id: ROW,
  at: "2026-11-10T13:10:00.000Z",
  role: "mentor",
  surface: "live_view",
  reader: { givenName: "Izmišljena", familyName: "Anić" },
};
const page = (e: object, next: unknown = null) => ({ entries: [e], next, continued: false });
const check = (value: unknown) => body !== undefined && Value.Check(body, value);

describe("student.access-log.get", () => {
  it("refuses exactly as a read: ownership only ever reads as 404", () => {
    expect(route?.errors.map((e) => `${e.status} ${e.code}`)).toEqual([
      "401 unauthorized",
      "403 forbidden",
      "404 not_found",
      "503 unavailable",
    ]);
    const missing = VECTORS.filter((v) => v.route === ID && v.response.status === 404);
    expect(missing.map((v) => v.name)).toEqual(["not-found-or-not-the-owner"]);
    const cross = VECTORS.find((v) => v.route === ID && v.response.status === 403);
    expect(cross?.request.headers?.["sec-fetch-site"]).toBe("cross-site");
  });

  it("an entry is one opening of five minutes", () => {
    expect(check(page(entry))).toBe(true);
    expect(check(page({ ...entry, reader: null }))).toBe(true);
    expect(check(page({ ...entry, role: "unknown", surface: "unknown" }))).toBe(true);
  });

  it.each(["count", "visits", "duration", "total"])(
    "carries no %s: not in the page, an entry or the cursor (D-274 MQ10)",
    (key) => {
      expect(check({ ...page(entry), [key]: 1 })).toBe(false);
      expect(check(page({ ...entry, [key]: 1 }))).toBe(false);
      expect(check(page(entry, { beforeAt: entry.at, beforeId: ROW, [key]: 1 }))).toBe(false);
    },
  );

  it.each([
    "2026-11-10T13:13:00.000Z",
    "2026-11-10T13:10:30.000Z",
    "2026-11-10T13:10:00.001Z",
    "2026-11-10T13:10:00.000",
    "2026-11-10T13:10:00.000Z\n",
    "2026-11-10T13:10:00.000Z\r\n",
    "2026-11-10T13:10:00.000Z\t",
    "2026-11-10T13:10:00.000Z ",
    "2026-11-10T13:10:00.000Z\u007f",
    "+012026-11-10T13:10:00.000Z",
  ])("the instant %j is off the five-minute grid or not toISOString", (at) => {
    expect(check(page({ ...entry, at }))).toBe(false);
    expect(check(page(entry, { beforeAt: at, beforeId: ROW }))).toBe(false);
  });

  it.each([
    "2026-99-99T99:10:00.000Z",
    "2026-00-10T13:10:00.000Z",
    "2026-13-10T13:10:00.000Z",
    "2026-11-00T13:10:00.000Z",
    "2026-11-32T13:10:00.000Z",
    "2026-11-31T13:10:00.000Z",
    "2026-04-31T13:10:00.000Z",
    "2026-02-29T13:10:00.000Z",
    "1900-02-29T13:10:00.000Z",
    "2026-02-30T13:10:00.000Z",
    "2026-11-10T24:00:00.000Z",
    "2026-11-10T13:60:00.000Z",
    "0000-01-01T00:00:00.000Z",
    "0000-02-29T00:00:00.000Z",
  ])("the instant %j is not on the calendar (QA #256 c.6948938937)", (at) => {
    expect(check(page({ ...entry, at }))).toBe(false);
    expect(check(page(entry, { beforeAt: at, beforeId: ROW }))).toBe(false);
  });

  it("takes every window start Date.toISOString gives from year 1 to 9999, leap days too", () => {
    const valid = (at: string) => check(page({ ...entry, at }));
    for (const at of ["2024-02-29", "2000-02-29", "1600-02-29", "0004-02-29", "0001-01-01"])
      expect(valid(`${at}T00:00:00.000Z`), at).toBe(true);
    expect(valid("9999-12-31T23:55:00.000Z")).toBe(true);
    // Every day of 1999 to 2032 (both kinds of leap year rule), at a window start.
    const step = 24 * 60 * 60_000 + 5 * 60_000;
    for (let ms = Date.UTC(1999, 0, 1); ms < Date.UTC(2033, 0, 1); ms += step) {
      const at = new Date(ms).toISOString();
      expect(valid(at), at).toBe(true);
    }
  });

  it("refuses any other shape of an entry or the cursor", () => {
    expect(check(page({ ...entry, id: ROW.toUpperCase() }))).toBe(false);
    expect(check(page({ ...entry, role: "admin" }))).toBe(false);
    expect(check(page({ ...entry, surface: "export" }))).toBe(false);
    expect(check(page({ ...entry, reader: { givenName: "Izmišljena" } }))).toBe(false);
    expect(check(page({ ...entry, toString: "x" }))).toBe(false);
    expect(check(page(JSON.parse(`{"__proto__":{},${JSON.stringify(entry).slice(1)}`)))).toBe(
      false,
    );
    expect(check(page(entry, { beforeAt: entry.at }))).toBe(false);
    expect(check(page(entry, { beforeAt: entry.at, beforeId: ROW.toUpperCase() }))).toBe(false);
    expect(check({ entries: [], next: null })).toBe(false);
  });

  it("a name is 1 to 255 code points, as the port counts", () => {
    const named = (givenName: string) =>
      check(page({ ...entry, reader: { givenName, familyName: "Anić" } }));
    expect(named("\u{1D4D0}".repeat(255))).toBe(true);
    expect(named("\u{1D4D0}".repeat(256))).toBe(false);
    expect(named("")).toBe(false);
  });

  it("a cursor it cannot read is still the first page, never an error", () => {
    const ignored = VECTORS.find((v) => v.route === ID && v.name === "cursor-ignored");
    expect(ignored?.request.query).toEqual({ beforeAt: "x" });
    expect((ignored?.response.body as { continued: boolean }).continued).toBe(false);
  });
});
