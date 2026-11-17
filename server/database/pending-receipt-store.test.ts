// DAN-820 820b-2b-2, plan of attack ductura/server#146 S-2, S-3, S-5: the
// worker's attach of a receipt signature answers one outcome of the
// function, `invalid` for a refused command before the database, or
// `unavailable` with a closed code; never an error text. Every identifier,
// digest and signature below is invented.
import { describe, expect, it } from "vitest";

import { createPendingReceiptStore } from "./pending-receipt-store.ts";

const RECEIPT = "00000000-0000-4000-8000-0000000000a1";
const DIGEST = "ab".repeat(32);
const SIG = {
  algorithm: "Ed25519",
  keyId: "kljuc-potvrde-1",
  keyVersion: "1",
  signatureEncoding: "raw",
  signatureBase64Url: "A".repeat(86),
};
const COMMAND = { receiptId: RECEIPT, payloadDigestSha256: DIGEST, signature: SIG };
const OTHER = [
  "invalid",
  "not_found",
  "unsupported_schema",
  "digest_mismatch",
  "key_unknown",
  "key_scope",
  "key_revoked",
  "key_not_valid",
];

function store(answer: () => unknown) {
  const calls: { text: string; values: unknown }[] = [];
  const db = {
    query: async (text: string, values: unknown) => {
      calls.push({ text, values });
      return answer();
    },
  };
  const made = createPendingReceiptStore(db as never);
  return { attach: (c: unknown) => made.attachSignature(c as never), made, calls };
}
const row =
  (outcome: unknown, signature: unknown = null) =>
  () => ({
    rows: [{ outcome, signature }],
  });
const named = <T>(name: string, values: unknown[], wrap: (v: unknown) => T) =>
  values.map((v): [string, T] => [`${name} ${JSON.stringify(v)}`, wrap(v)]);
const boom = () => {
  throw new Error("zamka");
};

describe("attachSignature answers invalid for a refused command, before the database (S-3)", () => {
  it.each<[string, unknown]>([
    ["null", null],
    ["extra key", { ...COMMAND, institutionId: RECEIPT }],
    [
      "getter",
      Object.defineProperty({ ...COMMAND }, "receiptId", { get: () => RECEIPT, enumerable: true }),
    ],
    ["ownKeys trap", new Proxy({ ...COMMAND }, { ownKeys: boom })],
    ["receiptId with CRLF", { ...COMMAND, receiptId: `${RECEIPT}\r\n` }],
    ["digest in capitals", { ...COMMAND, payloadDigestSha256: DIGEST.toUpperCase() }],
    ["RSA envelope", { ...COMMAND, signature: { ...SIG, algorithm: "RSA_PSS_SHA256" } }],
  ])("%s", async (_name, command) => {
    const { attach, calls } = store(row("signed", SIG));
    expect(await attach(command)).toStrictEqual({ outcome: "invalid" });
    expect(calls).toEqual([]);
  });
});

describe("an unexpected answer is row_malformed (S-2)", () => {
  const ok = { outcome: "not_found", signature: null };
  const inherited: unknown = Object.assign(Object.create({ signature: null }) as object, {
    outcome: "not_found",
  });
  it.each<[string, () => unknown]>([
    ...named(
      "answer",
      [{}, { rows: null }, { rows: [] }, { rows: [ok, ok] }, { rows: [null] }],
      (v) => () => v,
    ),
    ["missing column", () => ({ rows: [{ outcome: "not_found" }] })],
    ["extra column", () => ({ rows: [{ ...ok, key_id: "k" }] })],
    ["inherited column", () => ({ rows: [inherited] })],
    [
      "own __proto__",
      () => ({ rows: [JSON.parse('{"__proto__":{},"outcome":"not_found","signature":null}')] }),
    ],
    ["own toString", () => ({ rows: [{ ...ok, toString: "x" }] })],
    ...named("outcome", ["SIGNED", "signed ", "unavailable", "toString", 1, null], (v) => row(v)),
    ...named("signed with", [null, [SIG], "x"], (v) => row("signed", v)),
    ...named("already_signed with", [null, [SIG], "x"], (v) => row("already_signed", v)),
    ...named("a signature with", OTHER, (v) => row(v, SIG)),
  ])("%s", async (_name, answer) => {
    const malformed = { outcome: "unavailable", reason: "row_malformed" };
    expect(await store(answer).attach(COMMAND)).toStrictEqual(malformed);
  });
});

describe("a driver failure is a code only (S-5)", () => {
  const secret = "postgres://worker:tajna-lozinka@db.invalid/ductus";
  it.each([new Error(`connect failed ${secret}`), secret, undefined])("throws %s", async (e) => {
    const outcome = await store(() => {
      throw e;
    }).attach(COMMAND);
    expect(outcome).toStrictEqual({ outcome: "unavailable", reason: "database_error" });
    expect(JSON.stringify(outcome)).not.toContain("tajna");
  });
});

describe("controls: every outcome of the function, in one statement", () => {
  it.each(OTHER)("%s", async (o) => {
    expect(await store(row(o)).attach(COMMAND)).toStrictEqual({ outcome: o });
  });

  it.each(["signed", "already_signed"])("%s passes the stored signature on", async (o) => {
    const stored = { ...SIG, keyId: "drugi-kljuc" };
    const outcome = await store(row(o, stored)).attach(COMMAND);
    expect(outcome).toStrictEqual({ outcome: o, signature: stored });
  });

  it("sends the checked copy, the envelope in one key order", async () => {
    const { attach, calls } = store(row("signed", SIG));
    const reversed = Object.fromEntries(Object.entries(SIG).reverse());
    await attach(COMMAND);
    await attach({ signature: reversed, payloadDigestSha256: DIGEST, receiptId: RECEIPT });
    const values = [RECEIPT, DIGEST, JSON.stringify(SIG)];
    const text = expect.stringContaining(
      "app.worker_attach_receipt_signature($1::uuid, $2::text, $3::jsonb)",
    );
    expect(calls).toEqual([
      { text, values },
      { text, values },
    ]);
  });

  it("receiptKeys reads the keys of the domain over the same pool", async () => {
    const domain = "00000000-0000-4000-8000-0000000000d1";
    const { made, calls } = store(() => ({ rows: [] }));
    expect(await made.receiptKeys(domain)).toStrictEqual({ status: "ok", keys: [] });
    const text = expect.stringContaining("app.worker_receipt_keys($1::uuid)");
    expect(calls).toEqual([{ text, values: [domain] }]);
  });
});
