// The source proof port over a fake withActor: the input check before the
// database (page, note, a JPEG and never a whole PDF), the RPCs and their
// parameters, the confirmed row inside the transaction and the refusals as
// outcomes. Every value is invented.
import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";
import {
  createSourceProofs,
  isSourceProofJpeg,
  isSourceProofText,
  SOURCE_PROOF_MAX_BYTES,
} from "./source-proofs.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const ASSIGNMENT = "3a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c01";
const SOURCE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PROOF = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0xff, 0xd9]);
const PDF = Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n");
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
  return { port: createSourceProofs(withActor), seen, rolledBack: () => rolledBack };
}

const input = (over: Partial<Parameters<ReturnType<typeof fake>["port"]["add"]>[1]> = {}) => ({
  assignmentId: ASSIGNMENT,
  sourceId: SOURCE,
  page: "14",
  note: "Izmišljena bilješka\nu dva retka.",
  image: JPEG,
  ...over,
});

describe("input checks", () => {
  it.each([
    ["14", true],
    ["xii", true],
    ["14-15", true],
    ["", false],
    [" 14", false],
    ["14 ", false],
    ["1\n4", false],
    ["1\u00854", false],
    ["x".repeat(30), true],
    ["x".repeat(31), false],
    ["č".repeat(30), true],
  ])("page %j is %s", (page, ok) => {
    expect(isSourceProofText(page, 30, false)).toBe(ok);
  });

  it("lets a note hold line breaks but no other control character", () => {
    expect(isSourceProofText("prvi\ndrugi", 2000, true)).toBe(true);
    expect(isSourceProofText("prvi\tdrugi", 2000, true)).toBe(false);
    expect(isSourceProofText("prvi\r\ndrugi", 2000, true)).toBe(false);
  });

  it("takes only a JPEG within the bound, never a whole PDF", () => {
    expect(isSourceProofJpeg(JPEG)).toBe(true);
    expect(isSourceProofJpeg(PDF)).toBe(false);
    expect(isSourceProofJpeg(Buffer.from([0xff, 0xd8, 0xff]))).toBe(false);
    expect(isSourceProofJpeg(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd9]))).toBe(false);
    const big = Buffer.alloc(SOURCE_PROOF_MAX_BYTES + 1);
    big.set([0xff, 0xd8, 0xff], 0);
    big.set([0xff, 0xd9], big.length - 2);
    expect(isSourceProofJpeg(big)).toBe(false);
    expect(isSourceProofJpeg(big.subarray(1))).toBe(false);
  });
});

describe("add", () => {
  it("attaches through the RPC with the bytes as bytea and confirms the row", async () => {
    const row = { id: PROOF, page: "14", note: "Izmišljena bilješka\nu dva retka." };
    const { port, seen } = fake([row]);
    expect(await port.add(TOKEN, input())).toEqual({ status: "added", proof: row });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.sql).toContain("institution.add_source_proof($1::uuid, $2::uuid");
    const [assignment, source, page, note, image] = seen[0]!.values;
    expect([assignment, source, page, note]).toEqual([ASSIGNMENT, SOURCE, "14", row.note]);
    expect(Buffer.isBuffer(image) && image.equals(JPEG)).toBe(true);
  });

  it("refuses a PDF, a bad page or note before the database", async () => {
    const { port, seen } = fake();
    for (const bad of [
      input({ image: PDF }),
      input({ page: "" }),
      input({ page: "x".repeat(31) }),
      input({ note: " razmak" }),
    ]) {
      expect(await port.add(TOKEN, bad)).toEqual({ status: "invalid_input" });
    }
    expect(await port.add(TOKEN, input({ assignmentId: "nije-uuid" }))).toEqual({
      status: "not_found",
    });
    expect(seen).toHaveLength(0);
  });

  it("rolls back a row that is not the attached proof", async () => {
    const { port, rolledBack } = fake([{ id: PROOF, page: "15", note: null }]);
    await expect(port.add(TOKEN, input())).rejects.toThrow("unconfirmed source proof");
    expect(rolledBack()).toBe(1);
  });

  it.each([
    ["ZD401", { status: "unauthorized" }],
    ["ZD403", { status: "not_found" }],
    ["ZD422", { status: "invalid_input" }],
  ])("maps %s to an outcome", async (code, outcome) => {
    const { port } = fake(coded(code));
    expect(await port.add(TOKEN, input())).toEqual(outcome);
  });

  it("throws anything else", async () => {
    const { port } = fake(new Error("baza je pala"));
    await expect(port.add(TOKEN, input())).rejects.toThrow("baza je pala");
  });
});

describe("list", () => {
  it("reads the proofs of one source of the own work", async () => {
    const rows = [
      { id: PROOF, page: "14", note: null },
      { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", page: "xii", note: "Izmišljeno." },
    ];
    const { port, seen } = fake(rows);
    expect(await port.list(TOKEN, ASSIGNMENT, SOURCE)).toEqual({ status: "read", proofs: rows });
    expect(seen[0]!.sql).toContain("institution.source_proofs($1::uuid, $2::uuid, NULL)");
    expect(seen[0]!.values).toEqual([ASSIGNMENT, SOURCE]);
  });

  it("answers not_found for another's work and for a malformed id", async () => {
    const { port, seen } = fake(coded("ZD403"));
    expect(await port.list(TOKEN, ASSIGNMENT, SOURCE)).toEqual({ status: "not_found" });
    expect(await port.list(TOKEN, ASSIGNMENT, "nije-uuid")).toEqual({ status: "not_found" });
    expect(seen).toHaveLength(1);
  });

  it("throws on a row the database should never give", async () => {
    const { port } = fake([{ id: PROOF, page: "", note: null }]);
    await expect(port.list(TOKEN, ASSIGNMENT, SOURCE)).rejects.toThrow("invalid source proof row");
  });
});

describe("image", () => {
  it("reads the bytes of one proof named by work, source and id", async () => {
    const { port, seen } = fake([{ image: JPEG, sha256: "izmisljeno" }]);
    const result = await port.image(TOKEN, ASSIGNMENT, SOURCE, PROOF);
    expect(result.status).toBe("read");
    expect(result.status === "read" && result.image.equals(JPEG)).toBe(true);
    expect(seen[0]!.values).toEqual([ASSIGNMENT, SOURCE, PROOF]);
  });

  it("answers not_found for a proof of another work and throws on bytes that are no JPEG", async () => {
    expect(await fake(coded("ZD403")).port.image(TOKEN, ASSIGNMENT, SOURCE, PROOF)).toEqual({
      status: "not_found",
    });
    await expect(
      fake([{ image: PDF, sha256: "x" }]).port.image(TOKEN, ASSIGNMENT, SOURCE, PROOF),
    ).rejects.toThrow("invalid source proof image");
  });
});
