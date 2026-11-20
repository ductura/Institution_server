// The work attachment port over a fake withActor: the input check before the
// database, the RPC and its parameters, the confirmed row inside the
// transaction, the row shape and the refusals as outcomes. Every value is
// invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";
import {
  createWorkAttachments,
  isWorkAttachmentMediaType,
  WORK_ATTACHMENT_MAX_BYTES,
  type WorkAttachmentInput,
} from "./work-attachments.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const ASSIGNMENT = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
const STUDENT = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c02";
const ATTACHMENT = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const SHA = "0".repeat(64);
const AT = new Date("2026-11-20T10:00:00.000Z");
const INPUT: WorkAttachmentInput = {
  assignmentId: ASSIGNMENT,
  mediaType: "image/png",
  byteSize: 2048,
  sha256: SHA,
  storageRef: "privitci/izmisljeno",
  pixelWidth: 640,
  pixelHeight: 480,
};
const ROW = {
  id: ATTACHMENT,
  mediaType: "image/png",
  byteSize: 2048,
  sha256: SHA,
  pixelWidth: 640,
  pixelHeight: 480,
  storageRef: "privitci/izmisljeno",
  createdAt: AT,
};
const ATTACHMENT_OUT = { ...ROW, createdAt: AT.toISOString() };
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });

/** Each transaction answers its statements from `answers` in order; a throw rolls back. */
function fake(...answers: (unknown[] | Error)[]) {
  const seen: { sql: string; values: readonly unknown[] }[] = [];
  let rolledBack = 0;
  const withActor = (async (_token, fn) => {
    try {
      return await fn({
        async query(sql: string, values: readonly unknown[] = []) {
          seen.push({ sql, values });
          const next = answers.shift() ?? [];
          if (next instanceof Error) throw next;
          return { rows: next, rowCount: next.length };
        },
      } as unknown as ActorTransaction);
    } catch (error) {
      rolledBack += 1;
      throw error;
    }
  }) as WithActor;
  return { port: createWorkAttachments(withActor), seen, rolledBack: () => rolledBack };
}

describe("file types", () => {
  it.each([
    ["image/png", true],
    ["image/jpeg", true],
    ["image/svg+xml", false],
    ["image/gif", false],
    ["IMAGE/PNG", false],
    [undefined, false],
  ])("%s: %s", (type, ok) => expect(isWorkAttachmentMediaType(type)).toBe(ok));
});

describe("add", () => {
  it("sends the checked input through add_work_attachment and returns the new row", async () => {
    const { port, seen } = fake([{ ...ROW, created: true }]);
    const outcome = await port.add(TOKEN, INPUT);
    expect(outcome).toEqual({ status: "added", attachment: ATTACHMENT_OUT, created: true });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.sql).toContain("institution.add_work_attachment(");
    expect(seen[0]?.values).toEqual([
      ASSIGNMENT,
      "image/png",
      2048,
      SHA,
      "privitci/izmisljeno",
      640,
      480,
    ]);
  });

  it("answers the row already there for the same bytes, and sends no pixel size when unknown", async () => {
    const { port, seen } = fake([{ ...ROW, pixelWidth: null, pixelHeight: null, created: false }]);
    const withoutWidth: WorkAttachmentInput = {
      assignmentId: ASSIGNMENT,
      mediaType: "image/png",
      byteSize: 2048,
      sha256: SHA,
      storageRef: "privitci/izmisljeno",
      pixelHeight: null,
    };
    const outcome = await port.add(TOKEN, withoutWidth);
    expect(outcome).toEqual({
      status: "added",
      attachment: { ...ATTACHMENT_OUT, pixelWidth: null, pixelHeight: null },
      created: false,
    });
    expect(seen[0]?.values.slice(5)).toEqual([null, null]);
  });

  it.each([
    ["an assignment id in capitals", { assignmentId: ASSIGNMENT.toUpperCase() }],
    ["an SVG", { mediaType: "image/svg+xml" }],
    ["an empty file", { byteSize: 0 }],
    ["a file over 5 MiB", { byteSize: WORK_ATTACHMENT_MAX_BYTES + 1 }],
    ["a size that is not whole", { byteSize: 20.5 }],
    ["a hash in capitals", { sha256: "A".repeat(64) }],
    ["a hash of 63 digits", { sha256: "0".repeat(63) }],
    ["a storage reference with a space", { storageRef: "privitci/a b" }],
    ["an empty storage reference", { storageRef: "" }],
    ["a storage reference over 1024", { storageRef: "r".repeat(1025) }],
    ["a width without a height", { pixelHeight: null }],
    ["a width of 0", { pixelWidth: 0 }],
    ["a height over 20000", { pixelHeight: 20001 }],
  ])("refuses %s before the database", async (_label, change) => {
    const { port, seen } = fake();
    expect(await port.add(TOKEN, { ...INPUT, ...change })).toEqual({ status: "invalid_input" });
    expect(seen).toHaveLength(0);
  });

  it("accepts exactly 5 MiB and a reference of 1024", async () => {
    const big = { ...INPUT, byteSize: WORK_ATTACHMENT_MAX_BYTES, storageRef: "r".repeat(1024) };
    const { port } = fake([{ ...ROW, ...big, created: true }]);
    const outcome = await port.add(TOKEN, big);
    expect(outcome.status).toBe("added");
  });

  it.each([
    ["ZD401", { status: "unauthorized" }],
    ["ZD403", { status: "not_found" }],
    ["ZD422", { status: "invalid_input" }],
  ])("turns %s into an outcome", async (code, outcome) => {
    const { port } = fake(coded(code));
    expect(await port.add(TOKEN, INPUT)).toEqual(outcome);
  });

  it("throws any other error", async () => {
    const { port } = fake(coded("40001"));
    await expect(port.add(TOKEN, INPUT)).rejects.toThrow("izmišljeno");
  });

  it.each([
    ["no row", []],
    ["another hash", [{ ...ROW, sha256: "1".repeat(64), created: true }]],
    ["no created flag", [ROW]],
    [
      "an id that is not a UUID v4",
      [{ ...ROW, id: "aaaaaaaa-aaaa-1aaa-8aaa-aaaaaaaaaaaa", created: true }],
    ],
    ["an unknown file type", [{ ...ROW, mediaType: "image/gif", created: true }]],
    ["a timestamp as text", [{ ...ROW, createdAt: "2026-11-20", created: true }]],
  ])("rolls back on an unconfirmed answer: %s", async (_label, rows) => {
    const { port, rolledBack } = fake(rows);
    await expect(port.add(TOKEN, INPUT)).rejects.toThrow();
    expect(rolledBack()).toBe(1);
  });
});

describe("list", () => {
  it("reads the caller's own list with a null student", async () => {
    const { port, seen } = fake([ROW]);
    expect(await port.list(TOKEN, ASSIGNMENT, null)).toEqual({
      status: "read",
      attachments: [ATTACHMENT_OUT],
    });
    expect(seen[0]?.sql).toContain("institution.work_attachments(");
    expect(seen[0]?.values).toEqual([ASSIGNMENT, null]);
  });

  it("reads a student's list for a reader", async () => {
    const { port, seen } = fake([]);
    expect(await port.list(TOKEN, ASSIGNMENT, STUDENT)).toEqual({
      status: "read",
      attachments: [],
    });
    expect(seen[0]?.values).toEqual([ASSIGNMENT, STUDENT]);
  });

  it("answers not_found for a malformed id without asking the database", async () => {
    const { port, seen } = fake();
    expect(await port.list(TOKEN, "zadatak", null)).toEqual({ status: "not_found" });
    expect(await port.list(TOKEN, ASSIGNMENT, "student")).toEqual({ status: "not_found" });
    expect(seen).toHaveLength(0);
  });

  it("turns the refusals into outcomes and throws an invalid row", async () => {
    expect(await fake(coded("ZD403")).port.list(TOKEN, ASSIGNMENT, STUDENT)).toEqual({
      status: "not_found",
    });
    expect(await fake(coded("ZD401")).port.list(TOKEN, ASSIGNMENT, null)).toEqual({
      status: "unauthorized",
    });
    await expect(
      fake([{ ...ROW, byteSize: 0 }]).port.list(TOKEN, ASSIGNMENT, null),
    ).rejects.toThrow("invalid work attachment row");
  });
});

describe("read", () => {
  const RECORD_ROW = { ...ROW, assignmentId: ASSIGNMENT, studentId: STUDENT };

  it("reads one attachment with the work it belongs to", async () => {
    const { port, seen } = fake([RECORD_ROW]);
    expect(await port.read(TOKEN, ATTACHMENT)).toEqual({
      status: "read",
      attachment: { ...ATTACHMENT_OUT, assignmentId: ASSIGNMENT, studentId: STUDENT },
    });
    expect(seen[0]?.sql).toContain("institution.read_work_attachment(");
    expect(seen[0]?.values).toEqual([ATTACHMENT]);
  });

  it("answers not_found for a malformed id and for a refusal", async () => {
    const { port, seen } = fake();
    expect(await port.read(TOKEN, ATTACHMENT.toUpperCase())).toEqual({ status: "not_found" });
    expect(seen).toHaveLength(0);
    expect(await fake(coded("ZD403")).port.read(TOKEN, ATTACHMENT)).toEqual({
      status: "not_found",
    });
  });

  it("throws a row of another attachment", async () => {
    const other = { ...RECORD_ROW, id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" };
    await expect(fake([other]).port.read(TOKEN, ATTACHMENT)).rejects.toThrow(
      "invalid work attachment row",
    );
  });
});
