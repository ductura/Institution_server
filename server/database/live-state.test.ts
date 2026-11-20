// The live view port over a fake withActor (Ductus live-route.test.ts at
// 078c780, the database half): the statements, the ZD codes, the checks of a
// row, and that bytes are served only when they match their stored hash. All
// values are invented.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createLiveStates } from "./live-state.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-studenta-00000000000000001";
const DOC = "izmisljeni-rad-0001";
const WRITE = "1b2c3d4e-5f60-4718-8293-a4b5c6d7e8f9";
const TEXT = '{"izmisljeno":"č"}';
const HASH = createHash("sha256").update(TEXT, "utf8").digest("hex");

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
  return { states: createLiveStates(withActor), seen };
}
const coded = (code: string) => Object.assign(new Error("izmišljeno"), { code });
const MALFORMED = { status: "unavailable", reason: "row_malformed" };

describe("publish", () => {
  it("passes the work, the expected token and the text; answers the written token", async () => {
    const { states, seen } = fake([{ outcome: "accepted", write_token: WRITE }]);
    expect(await states.publish(TOKEN, DOC, null, TEXT)).toEqual({
      status: "accepted",
      token: WRITE,
    });
    expect(seen).toEqual([
      {
        token: TOKEN,
        sql: "SELECT outcome, write_token FROM collaboration.publish_live_state($1, $2, $3)",
        values: [DOC, null, TEXT],
      },
    ]);
  });

  it.each<[string, unknown[], unknown]>([
    [
      "unchanged",
      [{ outcome: "unchanged", write_token: WRITE }],
      { status: "unchanged", token: WRITE },
    ],
    [
      "conflict",
      [{ outcome: "conflict", write_token: WRITE }],
      { status: "conflict", token: WRITE },
    ],
    [
      "conflict, nothing published",
      [{ outcome: "conflict", write_token: null }],
      { status: "conflict", token: null },
    ],
    ["accepted without a token", [{ outcome: "accepted", write_token: null }], MALFORMED],
    ["an upper-case token", [{ outcome: "accepted", write_token: WRITE.toUpperCase() }], MALFORMED],
    ["an unknown outcome", [{ outcome: "stored", write_token: WRITE }], MALFORMED],
    [
      "two rows",
      [
        { outcome: "accepted", write_token: WRITE },
        { outcome: "accepted", write_token: WRITE },
      ],
      MALFORMED,
    ],
  ])("%s", async (_name, rows, expected) => {
    expect(await fake(rows).states.publish(TOKEN, DOC, WRITE, TEXT)).toEqual(expected);
  });

  it.each([
    ["ZD401", { status: "unauthenticated" }],
    ["ZD403", { status: "not_found" }],
    ["ZD422", { status: "invalid_document" }],
    ["ZD409", { status: "unavailable", reason: "database_error" }],
  ])("%s", async (code, expected) => {
    expect(await fake(coded(code)).states.publish(TOKEN, DOC, null, TEXT)).toEqual(expected);
    expect(await fake(coded(code)).states.read(TOKEN, DOC, null)).toEqual(expected);
  });
});

describe("read", () => {
  it("serves the stored bytes when they match their hash, marked when submitted", async () => {
    for (const outcome of ["state", "submitted"]) {
      const { states, seen } = fake([{ outcome, content_hash: HASH, body: TEXT }]);
      const read = await states.read(TOKEN, DOC, null);
      expect(read).toEqual({
        status: "state",
        hash: HASH,
        bytes: new Uint8Array(Buffer.from(TEXT, "utf8")),
        submitted: outcome === "submitted",
      });
      expect(seen[0]!.sql).toBe(
        "SELECT outcome, content_hash, body FROM collaboration.read_live_state($1, $2)",
      );
      expect(seen[0]!.values).toEqual([DOC, null]);
    }
  });

  it.each<[string, unknown[], string | null, unknown]>([
    ["empty", [{ outcome: "empty", content_hash: null, body: null }], null, { status: "empty" }],
    [
      "unchanged",
      [{ outcome: "unchanged", content_hash: HASH, body: null }],
      HASH,
      { status: "not_modified", hash: HASH, submitted: false },
    ],
    [
      "submitted, unchanged",
      [{ outcome: "submitted", content_hash: HASH, body: null }],
      HASH,
      { status: "not_modified", hash: HASH, submitted: true },
    ],
    [
      "unchanged for another ETag",
      [{ outcome: "unchanged", content_hash: HASH, body: null }],
      "0".repeat(64),
      MALFORMED,
    ],
    [
      "bytes that do not match their hash",
      [{ outcome: "state", content_hash: HASH, body: `${TEXT} ` }],
      null,
      MALFORMED,
    ],
    [
      "an upper-case hash",
      [{ outcome: "state", content_hash: HASH.toUpperCase(), body: TEXT }],
      null,
      MALFORMED,
    ],
    [
      "the submitted text unavailable",
      [{ outcome: "unavailable", content_hash: null, body: null }],
      null,
      { status: "unavailable", reason: "submitted_unavailable" },
    ],
    ["no row", [], null, MALFORMED],
  ])("%s", async (_name, rows, known, expected) => {
    expect(await fake(rows).states.read(TOKEN, DOC, known)).toEqual(expected);
  });
});
