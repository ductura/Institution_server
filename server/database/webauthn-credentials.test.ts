// DAN-840-3b (contract Ductus#1836 c.6940273164): the port of the WebAuthn
// credential RPCs maps the database's own refusals to outcomes, throws every
// other error again as it is, and lets no unchecked row out. All bytes and ids
// are invented.
import { describe, expect, it } from "vitest";

import { createWebAuthnCredentials } from "./webauthn-credentials.ts";
import type { ActorTransaction, WithActor } from "./with-actor.ts";

const TOKEN = "A".repeat(43);
const ID = Buffer.from([0x0a, 0x01]);
const KEY = Buffer.from([0x0b, 0x02, 0x03]);
const UUID = "0b5f6c1e-2d3a-4b5c-8d9e-0f1a2b3c4d5e";

function port(answer: () => Promise<unknown[]>) {
  const seen: { token: unknown; text: string; values: readonly unknown[] | undefined }[] = [];
  const withActor = (async (token, fn) => {
    const tx: ActorTransaction = {
      async query(text, values) {
        seen.push({ token, text, values });
        const rows = await answer();
        return { rows: rows as never[], rowCount: rows.length };
      },
    };
    return fn(tx);
  }) as WithActor;
  return { seen, port: createWebAuthnCredentials(withActor) };
}
const rows =
  (...list: unknown[]) =>
  () =>
    Promise.resolve(list);
const fails = (error: unknown) => () => Promise.reject(error);
const coded = (code: string) => Object.assign(new Error("izmišljena poruka baze"), { code });
const row = (fields: Record<string, unknown> = {}) => ({
  credential_id: ID,
  public_key: KEY,
  sign_count: "7",
  ...fields,
});

const calls = {
  list: (p: ReturnType<typeof port>["port"]) => p.list(TOKEN),
  add: (p: ReturnType<typeof port>["port"]) =>
    p.add(TOKEN, { credentialId: ID, publicKey: KEY, signCount: 0 }),
  use: (p: ReturnType<typeof port>["port"]) => p.use(TOKEN, ID, 5),
};

describe("refusals of the database", () => {
  it.each([
    ["list", "ZD401", "unauthenticated"],
    ["add", "ZD401", "unauthenticated"],
    ["add", "ZD403", "forbidden"],
    ["add", "ZD409", "conflict"],
    ["add", "ZD422", "invalid"],
    ["use", "ZD401", "unauthenticated"],
    ["use", "ZD403", "forbidden"],
    ["use", "ZD409", "counter_not_increased"],
    ["use", "ZD422", "invalid"],
  ] as const)("%s: %s is %s", async (method, code, status) => {
    expect(await calls[method](port(fails(coded(code))).port)).toEqual({ status });
  });

  const getter = Object.defineProperty(new Error("x"), "code", {
    get() {
      throw new Error("getter");
    },
  });
  it.each([
    ["list", coded("ZD403")],
    ["list", coded("ZD409")],
    ["list", coded("ZD422")],
    ["add", coded("42501")],
    ["add", coded("23505")],
    ["use", coded("25000")],
    ["use", coded("toString")],
    ["use", new Error("no code")],
    ["list", getter],
  ] as const)("%s throws any other error again as it is", async (method, error) => {
    await expect(calls[method](port(fails(error)).port)).rejects.toBe(error);
  });
});

describe("list", () => {
  it("returns checked rows in their order, the upper counter bound and an extra column", async () => {
    const other = Buffer.from([0x0a, 0x02]);
    const { port: p, seen } = port(
      rows(
        row({ sign_count: "4294967295", extra: 1 }),
        row({ credential_id: other, sign_count: 0 }),
      ),
    );
    expect(await p.list(TOKEN)).toEqual({
      status: "listed",
      credentials: [
        { credentialId: ID, publicKey: KEY, signCount: 4294967295 },
        { credentialId: other, publicKey: KEY, signCount: 0 },
      ],
    });
    expect(seen).toEqual([
      {
        token: TOKEN,
        text: "SELECT c.credential_id, c.public_key, c.sign_count FROM identity.webauthn_credentials_for_actor() c",
        values: [],
      },
    ]);
    expect(await port(rows()).port.list(TOKEN)).toEqual({ status: "listed", credentials: [] });
  });

  it.each([
    ["an id as text", row({ credential_id: "0a01" })],
    ["an empty id", row({ credential_id: Buffer.alloc(0) })],
    ["an id of 1024 bytes", row({ credential_id: Buffer.alloc(1024) })],
    ["an id that is not a Buffer", row({ credential_id: new Uint8Array([1]) })],
    ["a key of null", row({ public_key: null })],
    ["a key of 4097 bytes", row({ public_key: Buffer.alloc(4097) })],
    ...["-1", "01", "4294967296", "1e3", " 1", 1.5, 1n].map((n): [string, unknown] => [
      `the counter ${String(n)}`,
      row({ sign_count: n }),
    ]),
    ["no counter", { credential_id: ID, public_key: KEY }],
    [
      "an inherited counter",
      Object.assign(Object.create({ sign_count: "1" }), { credential_id: ID, public_key: KEY }),
    ],
    ["null", null],
  ] as [string, unknown][])("refuses %s", async (_name, bad) => {
    expect(await port(rows(row(), bad)).port.list(TOKEN)).toEqual({
      status: "unavailable",
      reason: "list_malformed",
    });
  });
});

describe("add and use", () => {
  it("pass id, key and counter in their places, the counter as text", async () => {
    const add = port(rows({ id: UUID }));
    expect(
      await add.port.add(TOKEN, { credentialId: ID, publicKey: KEY, signCount: 4294967295 }),
    ).toEqual({
      status: "added",
    });
    expect(add.seen).toEqual([
      {
        token: TOKEN,
        text: "SELECT identity.add_webauthn_credential($1::bytea, $2::bytea, $3::bigint) AS id",
        values: [ID, KEY, "4294967295"],
      },
    ]);
    const use = port(rows({ used: "" }));
    expect(await use.port.use(TOKEN, ID, 0)).toEqual({ status: "used" });
    expect(use.seen).toEqual([
      {
        token: TOKEN,
        text: "SELECT identity.use_webauthn_credential($1::bytea, $2::bigint) AS used",
        values: [ID, "0"],
      },
    ]);
  });

  it.each([1.5, Number.NaN, Number.POSITIVE_INFINITY, 1e21, -1, 2 ** 32])(
    "refuses the counter %s without a call",
    async (n) => {
      const { port: p, seen } = port(rows({ id: UUID }));
      expect(await p.add(TOKEN, { credentialId: ID, publicKey: KEY, signCount: n })).toEqual({
        status: "invalid",
      });
      expect(await p.use(TOKEN, ID, n)).toEqual({ status: "invalid" });
      expect(seen).toEqual([]);
    },
  );

  it.each([
    ["no row", []],
    [
      "two rows",
      [
        { id: UUID, used: "" },
        { id: UUID, used: "" },
      ],
    ],
    ["a row of another column", [{ other: UUID }]],
  ])("refuses %s", async (_name, list) => {
    expect(await calls.add(port(rows(...list)).port)).toEqual({
      status: "unavailable",
      reason: "add_malformed",
    });
    expect(await calls.use(port(rows(...list)).port)).toEqual({
      status: "unavailable",
      reason: "use_malformed",
    });
  });

  it("refuses an id that is not a UUID", async () => {
    for (const id of [null, "x", UUID.toUpperCase(), `${UUID}\n`])
      expect(await calls.add(port(rows({ id })).port)).toEqual({
        status: "unavailable",
        reason: "add_malformed",
      });
  });
});
