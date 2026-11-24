// The administrators' action log reader (SRV-ADMIN-1, SRV-ADMIN-2B): the
// rows of an import carry the course and the three counts, no other action
// carries any of them, and a row outside these sets is "unavailable". The
// reader never throws. All values are invented.
import { describe, expect, it } from "vitest";

import { createAdminActionLog } from "./index.ts";
import type { WithActor } from "../index.ts";

const TOKEN = "izmisljeni-token-admina-0000000000000000001";
const COURSE = "7e1a2b3c-4d5e-4f60-8a71-b2c3d4e5f601";
const AT = new Date("2026-11-24T10:00:00.000Z");

const NONE = { courseId: null, enrolled: null, alreadyEnrolled: null, skipped: null };
const IMPORT = { courseId: COURSE, enrolled: 3, alreadyEnrolled: 1, skipped: 2 };
const row = (fields: Record<string, unknown>): Record<string, unknown> => ({
  at: AT,
  actorRole: "institution_admin",
  action: "rule_published",
  subjectRole: null,
  outcome: "completed",
  ...NONE,
  ...fields,
});
const answering =
  (rows: Record<string, unknown>[]): WithActor =>
  async (_token, fn) =>
    fn({ query: async () => ({ rows: rows as never[], rowCount: rows.length }) });

const read = (rows: Record<string, unknown>[]) =>
  createAdminActionLog(answering(rows)).read(TOKEN, 500);

describe("admin action log: roster import entries", () => {
  it("reads a confirmed import with its course and counts, and others with none", async () => {
    const result = await read([row({ action: "roster_import_confirmed", ...IMPORT }), row({})]);
    expect(result).toEqual({
      status: "ok",
      truncated: false,
      entries: [
        {
          at: AT.toISOString(),
          actorRole: "institution_admin",
          action: "roster_import_confirmed",
          subjectRole: null,
          outcome: "completed",
          rosterImport: IMPORT,
        },
        {
          at: AT.toISOString(),
          actorRole: "institution_admin",
          action: "rule_published",
          subjectRole: null,
          outcome: "completed",
          rosterImport: null,
        },
      ],
    });
  });

  it.each([
    [
      "an import without its course",
      { action: "roster_import_confirmed", ...IMPORT, courseId: null },
    ],
    ["an import without a count", { action: "roster_import_confirmed", ...IMPORT, skipped: null }],
    [
      "an import with a negative count",
      { action: "roster_import_confirmed", ...IMPORT, enrolled: -1 },
    ],
    [
      "an import with a count past the file limit",
      { action: "roster_import_confirmed", ...IMPORT, enrolled: 1001 },
    ],
    [
      "an import with a fractional count",
      { action: "roster_import_confirmed", ...IMPORT, enrolled: 1.5 },
    ],
    [
      "an import whose course is no uuid",
      { action: "roster_import_confirmed", ...IMPORT, courseId: "Izmišljeni seminar" },
    ],
    [
      "an import with an upper-case uuid",
      { action: "roster_import_confirmed", ...IMPORT, courseId: COURSE.toUpperCase() },
    ],
    [
      "an import of another role",
      { action: "roster_import_confirmed", ...IMPORT, actorRole: "operator" },
    ],
    [
      "an import that names a role",
      { action: "roster_import_confirmed", ...IMPORT, subjectRole: "teacher" },
    ],
    ["another action with a course", { courseId: COURSE }],
    ["another action with a count", { enrolled: 0 }],
  ])("is unavailable for %s", async (_name, fields) => {
    expect(await read([row(fields)])).toEqual({ status: "unavailable" });
  });

  it("maps the refusals and never throws", async () => {
    const failing =
      (code: unknown): WithActor =>
      async () => {
        throw Object.assign(new Error("x"), { code });
      };
    const log = (code: unknown) => createAdminActionLog(failing(code)).read(TOKEN, 500);
    expect(await log("ZD401")).toEqual({ status: "unauthenticated" });
    expect(await log("ZD403")).toEqual({ status: "forbidden" });
    expect(await log("57P01")).toEqual({ status: "unavailable" });
  });
});
