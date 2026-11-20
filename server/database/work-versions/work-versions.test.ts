// The work versions port over a fake withActor: the one statement and its
// parameters, the refusals as outcomes, every row checked, the page order and
// the page end that never splits a revision. Every value is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";
import {
  createWorkVersionsReader,
  pageOf,
  versionOf,
  WORK_VERSIONS_PAGE_SIZE,
} from "./work-versions.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const DOCUMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddd01";
const MINUTE = new Date("2026-11-20T10:15:00.000Z");

const checkpoint = (revision: number, minute: Date = MINUTE) => ({
  outcome: "found",
  kind: "checkpoint",
  revision: String(revision),
  savedMinute: minute,
  afterDeadline: null,
});
const submission = (revision: number, afterDeadline = false) => ({
  outcome: "found",
  kind: "submission",
  revision: String(revision),
  savedMinute: MINUTE,
  afterDeadline,
});
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });

function fake(answer: unknown[] | Error) {
  const seen: { token: unknown; sql: string; values: readonly unknown[] }[] = [];
  const withActor = (async (token, fn) =>
    fn({
      async query(sql: string, values: readonly unknown[] = []) {
        seen.push({ token, sql, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer, rowCount: answer.length };
      },
    } as unknown as ActorTransaction)) as WithActor;
  return { read: createWorkVersionsReader(withActor), seen };
}

describe("createWorkVersionsReader", () => {
  it("asks app.read_work_versions once, with the document and the cursor only", async () => {
    const { read, seen } = fake([submission(7, true), checkpoint(7), checkpoint(3)]);
    const page = await read(TOKEN, DOCUMENT, 9);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.token).toBe(TOKEN);
    expect(seen[0]?.sql).toContain("FROM app.read_work_versions($1, $2::bigint)");
    expect(seen[0]?.values).toEqual([DOCUMENT, 9]);
    expect(page).toEqual({
      status: "found",
      versions: [
        {
          kind: "submission",
          revision: 7,
          savedMinute: "2026-11-20T10:15:00.000Z",
          afterDeadline: true,
        },
        { kind: "checkpoint", revision: 7, savedMinute: "2026-11-20T10:15:00.000Z" },
        { kind: "checkpoint", revision: 3, savedMinute: "2026-11-20T10:15:00.000Z" },
      ],
      nextBeforeRevision: null,
    });
  });

  it("sends a null cursor for the first page", async () => {
    const { read, seen } = fake([{ outcome: "empty" }]);
    expect(await read(TOKEN, DOCUMENT, null)).toEqual({
      status: "found",
      versions: [],
      nextBeforeRevision: null,
    });
    expect(seen[0]?.values).toEqual([DOCUMENT, null]);
  });

  it("answers not_found for the one row of every refusal", async () => {
    const { read } = fake([{ outcome: "not_found" }]);
    expect(await read(TOKEN, DOCUMENT, null)).toEqual({ status: "not_found" });
  });

  it("answers unauthenticated for ZD401 and rethrows anything else", async () => {
    expect(await fake(coded("ZD401")).read(TOKEN, DOCUMENT, null)).toEqual({
      status: "unauthenticated",
    });
    await expect(fake(coded("57014")).read(TOKEN, DOCUMENT, null)).rejects.toThrow();
  });

  it.each([0, 1, -3, 2.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "refuses the cursor %s before the database",
    async (before) => {
      const { read, seen } = fake([]);
      expect(await read(TOKEN, DOCUMENT, before)).toEqual({ status: "invalid_input" });
      expect(seen).toHaveLength(0);
    },
  );
});

describe("versionOf", () => {
  it.each([
    ["revision 0", { ...checkpoint(1), revision: "0" }],
    ["a revision that is a number", { ...checkpoint(1), revision: 4 }],
    ["a revision past the safe integers", { ...checkpoint(1), revision: "9007199254740993" }],
    ["a minute with seconds", checkpoint(2, new Date("2026-11-20T10:15:01.000Z"))],
    ["a minute that is text", { ...checkpoint(2), savedMinute: "2026-11-20T10:15:00.000Z" }],
    ["an invalid date", checkpoint(2, new Date(Number.NaN))],
    ["a checkpoint with a deadline flag", { ...checkpoint(2), afterDeadline: false }],
    ["a submission without one", { ...submission(2), afterDeadline: null }],
    ["an unknown kind", { ...checkpoint(2), kind: "draft" }],
    ["another outcome", { ...checkpoint(2), outcome: "empty" }],
  ])("refuses %s", (_name, row) => {
    expect(versionOf(row)).toBeNull();
  });
});

describe("pageOf", () => {
  it.each([
    ["no rows", []],
    ["a revision going up", [checkpoint(3), checkpoint(4)]],
    ["the same checkpoint twice", [checkpoint(3), checkpoint(3)]],
    ["a checkpoint before the submission of its revision", [checkpoint(3), submission(3)]],
    ["two submissions", [submission(5), submission(3)]],
    ["a row at the cursor", [checkpoint(9)]],
    ["not_found among versions", [checkpoint(3), { outcome: "not_found" }]],
    ["empty among versions", [checkpoint(3), { outcome: "empty" }]],
  ])("answers unavailable for %s", (_name, rows) => {
    expect(pageOf(rows, 9)).toEqual({ status: "unavailable", reason: "rows_malformed" });
  });

  it("refuses more rows than one past the page size", () => {
    const rows = Array.from({ length: WORK_VERSIONS_PAGE_SIZE + 2 }, (_, i) => checkpoint(500 - i));
    expect(pageOf(rows, null)).toEqual({ status: "unavailable", reason: "rows_malformed" });
  });

  it("ends a full page at the last kept revision and points the next page there", () => {
    const rows = Array.from({ length: WORK_VERSIONS_PAGE_SIZE + 1 }, (_, i) => checkpoint(500 - i));
    const page = pageOf(rows, null);
    expect(page.status).toBe("found");
    if (page.status !== "found") return;
    expect(page.versions).toHaveLength(WORK_VERSIONS_PAGE_SIZE);
    expect(page.versions.at(-1)?.revision).toBe(301);
    expect(page.nextBeforeRevision).toBe(301);
  });

  it("never splits a revision between two pages", () => {
    // 199 checkpoints, then the submission of revision 100 as row 200 and its
    // checkpoint as the extra row: both go to the next page.
    const rows = [
      ...Array.from({ length: WORK_VERSIONS_PAGE_SIZE - 1 }, (_, i) => checkpoint(400 - i)),
      submission(100),
      checkpoint(100),
    ];
    const page = pageOf(rows, null);
    expect(page.status).toBe("found");
    if (page.status !== "found") return;
    expect(page.versions).toHaveLength(WORK_VERSIONS_PAGE_SIZE - 1);
    expect(page.versions.some((version) => version.revision === 100)).toBe(false);
    expect(page.nextBeforeRevision).toBe(202);
  });
});
