// SRV-1110: the port of the Merlin package over a fake withActor. The input is
// checked before the database, every answer is confirmed inside the
// transaction (so a wrong one rolls the write back), and ZD401, ZD403, ZD409,
// ZD410 and ZD422 are outcomes. Every id, key and byte below is invented.
import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { ActorTransaction, WithActor } from "../index.ts";

import { createMerlinPackages, MERLIN_PACKAGE_MAX_BYTES } from "./merlin-packages.ts";

const TOKEN = "izmisljeni-token-nastavnika-000000000000001";
const A = "00000000-0000-4000-8000-0000000000a1";
const P = "00000000-0000-4000-8000-0000000000b1";
const KEY = "4b1e2c3d-0000-4000-8000-00000000aaa1";
const ZIP = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1, 2, 3, 4]);
const SHA = createHash("sha256").update(ZIP).digest("hex");
const EXPIRES = new Date("2026-11-22T09:15:00.000Z");

function port(answer: unknown) {
  const seen: { text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (_token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ text, values });
        if (answer instanceof Error) throw answer;
        return { rows: answer as never[], rowCount: 0 };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { port: createMerlinPackages(withActor), seen };
}
const sqlError = (code: string) => Object.assign(new Error("izmisljena greska"), { code });
const ready = (over: Record<string, unknown> = {}) => ({
  id: P,
  state: "ready",
  sha256: SHA,
  byteSize: ZIP.byteLength,
  expiresAt: EXPIRES,
  ...over,
});

describe("request", () => {
  it("asks once with the id and the key and reads the answer", async () => {
    const { port: p, seen } = port([{ id: P, state: "queued", claimed: true }]);
    expect(await p.request(TOKEN, A, KEY)).toEqual({
      status: "requested",
      id: P,
      state: "queued",
      claimed: true,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toContain("institution.request_merlin_package($1::uuid, $2::text)");
    expect(seen[0]!.values).toEqual([A, KEY]);
  });

  it("refuses a malformed id or key before the database", async () => {
    for (const [id, key, status] of [
      ["nije-uuid", KEY, "not_found"],
      [A.toUpperCase(), KEY, "not_found"],
      [A, "kratko", "invalid_input"],
      [A, "ima razmak u kljucu", "invalid_input"],
      [A, "a".repeat(129), "invalid_input"],
    ] as const) {
      const { port: p, seen } = port([]);
      expect(await p.request(TOKEN, id, key)).toEqual({ status });
      expect(seen).toEqual([]);
    }
  });

  it.each([
    ["ZD401", { status: "unauthorized" }],
    ["ZD403", { status: "not_found" }],
    ["ZD422", { status: "invalid_input" }],
  ])("%s is an outcome", async (code, outcome) => {
    expect(await port(sqlError(code)).port.request(TOKEN, A, KEY)).toEqual(outcome);
  });

  it.each([
    ["no row", []],
    [
      "two rows",
      [
        { id: P, state: "queued", claimed: true },
        { id: P, state: "queued", claimed: true },
      ],
    ],
    ["an unknown state", [{ id: P, state: "gotovo", claimed: false }]],
    ["a claim on a ready package", [{ id: P, state: "ready", claimed: true }]],
    ["an upper-case id", [{ id: P.toUpperCase(), state: "queued", claimed: true }]],
  ])("throws on %s", async (_name, rows) => {
    await expect(port(rows).port.request(TOKEN, A, KEY)).rejects.toThrow();
  });

  it("throws any other database error", async () => {
    await expect(port(sqlError("40001")).port.request(TOKEN, A, KEY)).rejects.toThrow();
  });
});

describe("complete", () => {
  it("stores the bytes and confirms the database's fingerprint and size", async () => {
    const { port: p, seen } = port([ready()]);
    expect(await p.complete(TOKEN, A, P, ZIP, SHA)).toEqual({
      status: "written",
      package: {
        id: P,
        state: "ready",
        sha256: SHA,
        byteSize: ZIP.byteLength,
        expiresAt: EXPIRES.toISOString(),
      },
    });
    expect(seen[0]!.values?.slice(0, 2)).toEqual([A, P]);
    expect(Buffer.from(seen[0]!.values?.[2] as Uint8Array).equals(Buffer.from(ZIP))).toBe(true);
  });

  it.each([
    ["another fingerprint", ready({ sha256: "0".repeat(64) })],
    ["another size", ready({ byteSize: 9 })],
    ["another package", ready({ id: A })],
    ["a queued answer", { id: P, state: "queued", sha256: null, byteSize: null, expiresAt: null }],
    ["an expiry that is not a date", ready({ expiresAt: "sutra" })],
  ])("throws on %s, so the write rolls back", async (_name, row) => {
    await expect(port([row]).port.complete(TOKEN, A, P, ZIP, SHA)).rejects.toThrow();
  });

  it("never sends an empty or an oversized ZIP", async () => {
    const { port: p, seen } = port([ready()]);
    await expect(p.complete(TOKEN, A, P, new Uint8Array(0), SHA)).rejects.toThrow();
    await expect(
      p.complete(TOKEN, A, P, new Uint8Array(MERLIN_PACKAGE_MAX_BYTES + 1), SHA),
    ).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it.each([
    ["ZD401", { status: "unauthorized" }],
    ["ZD403", { status: "not_found" }],
    ["ZD409", { status: "not_ready" }],
  ])("%s is an outcome", async (code, outcome) => {
    expect(await port(sqlError(code)).port.complete(TOKEN, A, P, ZIP, SHA)).toEqual(outcome);
  });
});

describe("fail", () => {
  it("records a closed code", async () => {
    const { port: p, seen } = port([{ id: P, state: "failed" }]);
    expect(await p.fail(TOKEN, A, P, "roster_unavailable")).toEqual({
      status: "written",
      package: { id: P, state: "failed", sha256: null, byteSize: null, expiresAt: null },
    });
    expect(seen[0]!.values).toEqual([A, P, "roster_unavailable"]);
  });

  it("never sends a code that is not closed", async () => {
    const { port: p, seen } = port([{ id: P, state: "failed" }]);
    await expect(p.fail(TOKEN, A, P, "Neki tekst iznimke")).rejects.toThrow();
    expect(seen).toEqual([]);
  });

  it("ZD409 is an outcome, an unconfirmed answer throws", async () => {
    expect(await port(sqlError("ZD409")).port.fail(TOKEN, A, P, "build_failed")).toEqual({
      status: "not_ready",
    });
    await expect(port([{ id: P, state: "queued" }]).port.fail(TOKEN, A, P, "x")).rejects.toThrow();
  });
});

describe("status", () => {
  it.each([
    ["queued", { id: P, state: "queued", sha256: null, byteSize: null, expiresAt: null }],
    ["failed", { id: P, state: "failed", sha256: null, byteSize: null, expiresAt: null }],
    ["ready", ready()],
    ["expired", ready({ state: "expired" })],
  ])("reads a %s package", async (state, row) => {
    const got = await port([row]).port.status(TOKEN, A, P);
    expect(got).toMatchObject({ status: "read", package: { id: P, state } });
  });

  it("a malformed id is not_found before the database", async () => {
    const { port: p, seen } = port([ready()]);
    expect(await p.status(TOKEN, A, "nije-uuid")).toEqual({ status: "not_found" });
    expect(seen).toEqual([]);
  });

  it.each([
    [
      "a queued package with a fingerprint",
      { id: P, state: "queued", sha256: SHA, byteSize: 8, expiresAt: EXPIRES },
    ],
    ["a ready package without one", ready({ sha256: null })],
    ["another package", ready({ id: A })],
  ])("throws on %s", async (_name, row) => {
    await expect(port([row]).port.status(TOKEN, A, P)).rejects.toThrow();
  });

  it("ZD403 is not_found", async () => {
    expect(await port(sqlError("ZD403")).port.status(TOKEN, A, P)).toEqual({ status: "not_found" });
  });
});

describe("download", () => {
  it("hands out the bytes and the fingerprint", async () => {
    const got = await port([{ content: Buffer.from(ZIP), sha256: SHA }]).port.download(TOKEN, A, P);
    expect(got).toMatchObject({ status: "downloaded", sha256: SHA });
  });

  it.each([
    ["ZD401", { status: "unauthorized" }],
    ["ZD403", { status: "not_found" }],
    ["ZD409", { status: "not_ready" }],
    ["ZD410", { status: "expired" }],
  ])("%s is an outcome", async (code, outcome) => {
    expect(await port(sqlError(code)).port.download(TOKEN, A, P)).toEqual(outcome);
  });

  it("throws on bytes that are not bytes", async () => {
    await expect(
      port([{ content: "PK", sha256: SHA }]).port.download(TOKEN, A, P),
    ).rejects.toThrow();
  });
});
