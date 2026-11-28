// DAN-818, attack plan ductura/server#136 A and E: the rows of the two replay
// RPCs are checked before they leave server/database; a missing session is
// 401, a row of another form is unavailable, never "not found" and never a
// partial answer. Every identifier and hash below is invented.
import { describe, expect, it } from "vitest";

import {
  createReplayResolutionReader,
  createReplaySource,
  resolutionsResult,
  sourceResult,
} from "./replay-source.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "izmisljeni-token-evidencije-000000000000001";
const INSTITUTION = "11111111-1111-4111-8111-111111111111";
const DOC = "dokument-izmisljeni-zv-1";
const A = "a".repeat(64);
const B = "b".repeat(64);
const FOUND = {
  outcome: "found",
  institution_id: INSTITUTION,
  evidence_package_id: "paket-izmisljeni-1",
  segment_hashes: [A, B],
};

function sourceWith(answer: (text: string) => Record<string, unknown>[] | Error) {
  const seen: { text: string; values: readonly unknown[] | undefined; token: unknown }[] = [];
  const withActor = (async (token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values, token });
        const rows = answer(text);
        if (rows instanceof Error) throw rows;
        return { rows: rows as never[], rowCount: rows.length };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { source: createReplaySource(withActor, TOKEN), seen };
}

const zd401 = () => Object.assign(new Error("izmisljena greska"), { code: "ZD401" });

describe("sourceResult", () => {
  it("names the institution and package from the row and the head from the last hash", () => {
    expect(sourceResult([FOUND])).toEqual({
      status: "found",
      institutionId: INSTITUTION,
      evidencePackageId: "paket-izmisljeni-1",
      head: { segmentHash: B, segmentCount: 2 },
      segmentHashes: [A, B],
    });
    expect(sourceResult([{ ...FOUND, segment_hashes: [] }])).toMatchObject({ head: null });
  });

  it("keeps not_found and unavailable apart", () => {
    expect(sourceResult([{ outcome: "not_found" }])).toEqual({ status: "not_found" });
    expect(sourceResult([{ outcome: "unavailable" }])).toEqual({
      status: "unavailable",
      reason: "source_unavailable",
    });
  });

  it.each([
    ["no row", []],
    ["two rows", [FOUND, FOUND]],
    ["an unknown outcome", [{ ...FOUND, outcome: "teacher" }]],
    ["an institution that is not a UUID", [{ ...FOUND, institution_id: "ustanova-1" }]],
    ["no institution", [{ ...FOUND, institution_id: null }]],
    ["a package id with a slash", [{ ...FOUND, evidence_package_id: "../paket" }]],
    ["no package", [{ ...FOUND, evidence_package_id: null }]],
    ["a package id that is a number", [{ ...FOUND, evidence_package_id: 7 }]],
    ["no outcome", [{ ...FOUND, outcome: undefined }]],
    ["an uppercase hash", [{ ...FOUND, segment_hashes: [A.toUpperCase()] }]],
    ["hashes that are not a list", [{ ...FOUND, segment_hashes: A }]],
  ])("%s is unavailable, never not_found", (_, rows) => {
    expect(sourceResult(rows as Record<string, unknown>[])).toEqual({
      status: "unavailable",
      reason: "source_malformed",
    });
  });
});

describe("createReplaySource", () => {
  it("presents the token to withActor and passes only the document id", async () => {
    const { source, seen } = sourceWith(() => [FOUND]);
    await source.readSource(DOC);
    expect(seen).toEqual([
      { text: expect.stringContaining("app.read_replay_source($1)"), values: [DOC], token: TOKEN },
    ]);
  });

  it("is unauthenticated on ZD401 and rethrows any other error", async () => {
    expect(await sourceWith(() => zd401()).source.readSource(DOC)).toEqual({
      status: "unauthenticated",
    });
    expect(await sourceWith(() => zd401()).source.readCheckpoints(DOC, [A])).toEqual({
      status: "unauthenticated",
    });
    const other = new Error("izmisljeni pad");
    await expect(sourceWith(() => other).source.readSource(DOC)).rejects.toBe(other);
    await expect(sourceWith(() => other).source.readCheckpoints(DOC, [A])).rejects.toBe(other);
  });

  it("maps checkpoint texts by hash; a hash without a row is simply absent", async () => {
    const { source, seen } = sourceWith(() => [{ content_hash: A, body: "{}" }]);
    const result = await source.readCheckpoints(DOC, [A, B]);
    expect(result).toEqual({ status: "found", texts: new Map([[A, "{}"]]) });
    expect(seen[0]?.values).toEqual([DOC, [A, B]]);
  });

  it.each([
    [
      "a duplicate hash",
      [
        { content_hash: A, body: "{}" },
        { content_hash: A, body: "{}" },
      ],
    ],
    ["a body that is not text", [{ content_hash: A, body: null }]],
    ["a hash that is not text", [{ content_hash: 1, body: "{}" }]],
  ])("%s makes the checkpoints unavailable", async (_, rows) => {
    expect(await sourceWith(() => rows).source.readCheckpoints(DOC, [A])).toEqual({
      status: "unavailable",
      reason: "checkpoints_malformed",
    });
  });
});

describe("resolutionsResult (F4-EDI-R05-SRV B1)", () => {
  it("names each segment and its base; no row is no resolution", () => {
    expect(
      resolutionsResult([
        { segment_hash: A, conflict_base_revision: "0" },
        { segment_hash: B, conflict_base_revision: 1 },
      ]),
    ).toEqual({
      status: "found",
      marks: [
        { segmentHash: A, conflictBaseRevision: 0 },
        { segmentHash: B, conflictBaseRevision: 1 },
      ],
    });
    expect(resolutionsResult([])).toEqual({ status: "found", marks: [] });
  });

  it.each([
    ["a hash in capitals", { segment_hash: A.toUpperCase(), conflict_base_revision: 0 }],
    ["no hash", { conflict_base_revision: 0 }],
    ["a negative base", { segment_hash: A, conflict_base_revision: -1 }],
    ["a fractional base", { segment_hash: A, conflict_base_revision: 1.5 }],
    ["no base", { segment_hash: A, conflict_base_revision: null }],
    [
      "a base beyond a safe integer",
      { segment_hash: A, conflict_base_revision: "9007199254740993" },
    ],
    ["a base that is no number", { segment_hash: A, conflict_base_revision: "x" }],
  ])("is unavailable for %s, never a partial answer", (_label, row) => {
    expect(resolutionsResult([{ segment_hash: B, conflict_base_revision: 0 }, row])).toEqual({
      status: "unavailable",
      reason: "resolutions_malformed",
    });
  });

  it("is unavailable when one segment is named twice", () => {
    const row = { segment_hash: A, conflict_base_revision: 0 };
    expect(resolutionsResult([row, row])).toMatchObject({ status: "unavailable" });
  });
});

describe("createReplayResolutionReader", () => {
  function readerWith(answer: () => Record<string, unknown>[] | Error) {
    const seen: { text: string; values: readonly unknown[] | undefined; token: unknown }[] = [];
    const withActor = (async (token, fn) =>
      fn({
        async query(text, values) {
          seen.push({ text, values, token });
          const rows = answer();
          if (rows instanceof Error) throw rows;
          return { rows: rows as never[], rowCount: rows.length };
        },
      })) as WithActor;
    return { reader: createReplayResolutionReader(withActor, TOKEN), seen };
  }

  it("reads through app.read_replay_resolutions with only the document id as a parameter", async () => {
    const { reader, seen } = readerWith(() => [{ segment_hash: A, conflict_base_revision: 2 }]);
    await expect(reader.readResolutions(DOC)).resolves.toEqual({
      status: "found",
      marks: [{ segmentHash: A, conflictBaseRevision: 2 }],
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.text).toContain("app.read_replay_resolutions($1)");
    expect(seen[0]?.values).toEqual([DOC]);
    expect(seen[0]?.token).toBe(TOKEN);
  });

  it("answers unauthenticated for ZD401 and rethrows anything else", async () => {
    await expect(readerWith(zd401).reader.readResolutions(DOC)).resolves.toEqual({
      status: "unauthenticated",
    });
    const other = new Error("izmisljeni kvar");
    await expect(readerWith(() => other).reader.readResolutions(DOC)).rejects.toBe(other);
  });
});
