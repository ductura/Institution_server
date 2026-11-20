// The answer of work.versions.get over a fake reader: the closed query and
// its cursor, the one call to the port, and every outcome as its status and
// body. Every value is invented.
import { describe, expect, it, vi } from "vitest";

import type { WorkVersionsPage, WorkVersionsReader } from "../../database/index.ts";
import { answerWorkVersions, beforeRevisionOf } from "./work-versions.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const DOCUMENT = "dddddddd-dddd-4ddd-8ddd-dddddddddd01";
const PAGE: WorkVersionsPage = {
  status: "found",
  versions: [
    {
      kind: "submission",
      revision: 7,
      savedMinute: "2026-11-27T22:41:00.000Z",
      afterDeadline: false,
    },
    { kind: "checkpoint", revision: 7, savedMinute: "2026-11-27T22:40:00.000Z" },
  ],
  nextBeforeRevision: 7,
};

function fake(page: WorkVersionsPage | Error) {
  const read = vi.fn<WorkVersionsReader>(async () => {
    if (page instanceof Error) throw page;
    return page;
  });
  return read;
}

describe("beforeRevisionOf", () => {
  it.each([
    ["", null],
    ["beforeRevision=2", 2],
    ["beforeRevision=9007199254740991", 9007199254740991],
  ])("reads %j as %s", (search, before) => {
    expect(beforeRevisionOf(new URLSearchParams(search))).toBe(before);
  });

  it.each([
    "beforeRevision=1",
    "beforeRevision=0",
    "beforeRevision=02",
    "beforeRevision=-3",
    "beforeRevision=2.0",
    "beforeRevision=",
    "beforeRevision=9007199254740993",
    "beforeRevision=2&beforeRevision=3",
    "beforeRevision=3&role=teacher",
    "studentId=00000000-0000-4000-8000-0000000000a1",
  ])("refuses %j", (search) => {
    expect(beforeRevisionOf(new URLSearchParams(search))).toBeUndefined();
  });
});

describe("answerWorkVersions", () => {
  it("reads one page with the token, the document and the cursor only", async () => {
    const read = fake(PAGE);
    const answer = await answerWorkVersions(
      read,
      TOKEN,
      DOCUMENT,
      new URLSearchParams("beforeRevision=9"),
    );
    expect(read).toHaveBeenCalledExactlyOnceWith(TOKEN, DOCUMENT, 9);
    expect(answer).toEqual({
      status: 200,
      body: { versions: PAGE.versions, nextBeforeRevision: 7 },
    });
  });

  it("refuses a bad cursor before the database", async () => {
    const read = fake(PAGE);
    expect(
      await answerWorkVersions(read, TOKEN, DOCUMENT, new URLSearchParams("beforeRevision=1")),
    ).toEqual({ status: 422, code: "invalid_input" });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    [{ status: "not_found" }, { status: 404, code: "not_found" }],
    [{ status: "unauthenticated" }, { status: 401, code: "unauthorized" }],
    [{ status: "invalid_input" }, { status: 422, code: "invalid_input" }],
    [
      { status: "unavailable", reason: "rows_malformed" },
      { status: 503, code: "unavailable", reason: "rows_malformed" },
    ],
  ] as const)("answers %j as %j", async (page, answer) => {
    expect(await answerWorkVersions(fake(page), TOKEN, DOCUMENT, new URLSearchParams())).toEqual(
      answer,
    );
  });

  it("lets a failure of the read reach the route", async () => {
    await expect(
      answerWorkVersions(fake(new Error("izmišljeno")), TOKEN, DOCUMENT, new URLSearchParams()),
    ).rejects.toThrow();
  });
});
