// DAN-820 820b-2a, plan of attack ductura/server#146 S-2, S-3, S-5: the
// worker's read of a domain's receipt keys returns the whole list or a
// closed code, never a partial list or an error text. Every identifier and
// key below is invented.
import { describe, expect, it } from "vitest";

import { readReceiptKeys } from "./receipt-keys.ts";

const DOMAIN = "00000000-0000-4000-8000-0000000000d1";
const FROM = "2026-11-01T10:00:00.000Z";
const KEY: Record<string, string | null> = {
  key_id: "kljuc-potvrde-1",
  key_version: "1",
  key_base64url: "MCowBQYDK2VwAyEA" + "A".repeat(43),
  valid_from: FROM,
  valid_to: null,
  revoked_at: null,
};

function keys(answer: () => unknown) {
  const calls: { text: string; values: readonly unknown[] | undefined }[] = [];
  const db = {
    query: async (text: string, values?: readonly unknown[]) => {
      calls.push({ text, values });
      return answer();
    },
  };
  return { read: (domain: unknown) => readReceiptKeys(db as never, domain as string), calls };
}
const rows = (...list: unknown[]) => keys(() => ({ rows: list }));
const malformed = { status: "unavailable", reason: "row_malformed" };

describe("readReceiptKeys refuses a domain before the database (S-3)", () => {
  it.each([
    "",
    DOMAIN.toUpperCase(),
    ` ${DOMAIN}`,
    `${DOMAIN}\n`,
    `${DOMAIN}\r\n`,
    `${DOMAIN}\t`,
    `${DOMAIN} `,
    `${DOMAIN}\u007f`,
    `{${DOMAIN}}`,
    `urn:uuid:${DOMAIN}`,
    DOMAIN.replaceAll("-", ""),
    "00000000-0000-1000-8000-0000000000d1",
    undefined,
    null,
    42,
    {},
  ])("domain %j", async (domain) => {
    const { read, calls } = rows(KEY);
    expect(await read(domain)).toEqual({ status: "unavailable", reason: "request_invalid" });
    expect(calls).toEqual([]);
  });
});

const inherited: object = Object.create({ revoked_at: null });
for (const [column, value] of Object.entries(KEY)) {
  if (column !== "revoked_at")
    Object.defineProperty(inherited, column, { value, enumerable: true });
}
const ownProto = JSON.parse(JSON.stringify(KEY).replace("{", '{"__proto__":{},'));
const badTimes = [
  new Date(FROM),
  "2026-11-01T10:00:00.000+00",
  "2026-11-01T10:00:00.000",
  "2026-11-01T10:00:00Z",
  "",
  "2026-02-30T10:00:00.000Z",
  "2026-11-01T25:00:00.000Z",
  42,
];

describe("an unexpected answer makes the whole read row_malformed (S-2)", () => {
  it.each<[string, () => unknown]>([
    ["no rows array", () => ({})],
    ["rows null", () => ({ rows: null })],
    ["rows not an array", () => ({ rows: { 0: KEY } })],
    ["null row", () => ({ rows: [KEY, null] })],
    ["string row", () => ({ rows: ["x"] })],
    ["array row", () => ({ rows: [Object.values(KEY)] })],
    ["missing column", () => ({ rows: [{ ...KEY, revoked_at: undefined }] })],
    ["extra column", () => ({ rows: [{ ...KEY, purpose: "receipt" }] })],
    ["inherited column", () => ({ rows: [inherited] })],
    ["own __proto__", () => ({ rows: [ownProto] })],
    ["own toString", () => ({ rows: [{ ...KEY, toString: "x" }] })],
    ["key id repeated", () => ({ rows: [KEY, { ...KEY, key_version: "2" }] })],
    // Past the bounds of isPublicVerificationKey: 2048 for an id, 256 for a version.
    ...(
      [
        ["key_id", "a".repeat(2049)],
        ["key_version", "a".repeat(257)],
        ["key_base64url", "a+b/"],
        ["key_base64url", "aaaa="],
      ] as const
    ).flatMap(([column, over]): [string, () => unknown][] =>
      ["", 7, null, over].map((v) => [
        `${column} ${JSON.stringify(v).slice(0, 12)}`,
        () => ({ rows: [{ ...KEY, [column]: v }] }),
      ]),
    ),
    ...badTimes.flatMap((t): [string, () => unknown][] =>
      ["valid_from", "valid_to", "revoked_at"].map((column) => [
        `${column} ${String(t)}`,
        () => ({ rows: [{ ...KEY, [column]: t }] }),
      ]),
    ),
    ["valid_from null", () => ({ rows: [{ ...KEY, valid_from: null }] })],
  ])("%s", async (_name, answer) => {
    expect(await keys(answer).read(DOMAIN)).toEqual(malformed);
  });
});

describe("a driver failure is a code only (S-5)", () => {
  const secret = "postgres://worker:tajna-lozinka@db.invalid/ductus";
  it.each([new Error(`connect failed ${secret}`), secret, undefined])("throws %s", async (e) => {
    const read = await keys(() => {
      throw e;
    }).read(DOMAIN);
    expect(read).toEqual({ status: "unavailable", reason: "database_error" });
    expect(JSON.stringify(read)).not.toContain("tajna");
  });
});

describe("controls: the keys of the domain, in the database's order", () => {
  it("an active, a retired and a revoked key, in one statement", async () => {
    const retired = { ...KEY, key_id: "k2", valid_to: "2026-11-02T10:00:00.000Z" };
    const revoked = { ...KEY, key_id: "k3", revoked_at: "2026-11-03T10:00:00.123Z" };
    const { read, calls } = rows(KEY, retired, revoked);
    const key = (row: typeof KEY) => ({
      algorithm: "Ed25519",
      keyId: row.key_id,
      keyVersion: row.key_version,
      encoding: "spki-der",
      keyBase64Url: row.key_base64url,
      evidenceDomainId: DOMAIN,
      purpose: "receipt",
      validFrom: row.valid_from,
      validTo: row.valid_to,
      revokedAt: row.revoked_at,
    });
    expect(await read(DOMAIN)).toEqual({
      status: "ok",
      keys: [key(KEY), key(retired), key(revoked)],
    });
    expect(calls).toEqual([
      { text: expect.stringContaining("app.worker_receipt_keys($1::uuid)"), values: [DOMAIN] },
    ]);
  });

  it("no key is an empty list", async () => {
    expect(await rows().read(DOMAIN)).toEqual({ status: "ok", keys: [] });
  });
});
