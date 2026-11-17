// DAN-820 820b-2b-1, plan of attack ductura/server#146 S-3: the attach
// command is a checked copy or null, before the database. Every identifier,
// digest and signature below is invented.
import { describe, expect, it } from "vitest";

import { checkedAttachCommand } from "./attach-command.ts";

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

/** Named table rows, each value put into a command by `wrap`. */
const named = (name: string, values: unknown[], wrap: (v: unknown) => unknown) =>
  values.map((v): [string, unknown] => [`${name} ${JSON.stringify(v)}`, wrap(v)]);
const withProto = (proto: object, own: object): unknown =>
  Object.assign(Object.create(proto) as object, own);
const ownProto = (value: object): unknown =>
  JSON.parse(JSON.stringify(value).replace("{", '{"__proto__":{},'));
const getter = (value: object, key: string, get: () => unknown) =>
  Object.defineProperty({ ...value }, key, { get, enumerable: true });
const boom = () => {
  throw new Error("zamka");
};
const trap = (name: string) => new Proxy({ ...COMMAND }, { [name]: boom });
const tails = ["\n", "\r\n", "\t", " ", "\u007f", " "];
const ids = ["", RECEIPT.toUpperCase(), `{${RECEIPT}}`, `urn:uuid:${RECEIPT}`, ` ${RECEIPT}`, 42];
const envelopes = [
  null,
  "x",
  { ...SIG, extra: 1 },
  { ...SIG, keyId: " " },
  { ...SIG, signatureEncoding: "der" },
  { ...SIG, signatureBase64Url: "A+" },
  { ...SIG, algorithm: "RSA_PSS_SHA256" },
  { ...SIG, toString: "x" },
  ownProto(SIG),
  getter(SIG, "keyId", () => "k"),
];

describe("checkedAttachCommand refuses every bad command (S-3)", () => {
  it.each<[string, unknown]>([
    ...named("command", [null, undefined, JSON.stringify(COMMAND), [RECEIPT]], (v) => v),
    ["date", new Date()],
    ["class instance", new (class Command {})()],
    ["missing key", { receiptId: RECEIPT, payloadDigestSha256: DIGEST }],
    ["extra key", { ...COMMAND, institutionId: RECEIPT }],
    ["inherited key", withProto({ signature: SIG }, { ...COMMAND, signature: undefined })],
    ["inherited only", withProto(COMMAND, {})],
    ["own __proto__", ownProto(COMMAND)],
    ["own toString", { ...COMMAND, toString: "x" }],
    ["own constructor", { ...COMMAND, constructor: "x" }],
    ["symbol key", { ...COMMAND, [Symbol("x")]: 1 }],
    ["getter", getter(COMMAND, "receiptId", () => RECEIPT)],
    ["getter that throws", getter(COMMAND, "receiptId", boom)],
    ...["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"].map((n): [string, unknown] => [
      `${n} trap`,
      trap(n),
    ]),
    ...named(
      "receiptId",
      [...ids, RECEIPT.replaceAll("-", ""), ...tails.map((t) => RECEIPT + t)],
      (v) => ({
        ...COMMAND,
        receiptId: v,
      }),
    ),
    ...named(
      "digest",
      [DIGEST.slice(1), `${DIGEST}a`, DIGEST.toUpperCase(), ...tails.map((t) => DIGEST + t)],
      (v) => ({
        ...COMMAND,
        payloadDigestSha256: v,
      }),
    ),
    ...named("signature", envelopes, (v) => ({ ...COMMAND, signature: v })),
  ])("%s", (_name, command) => {
    expect(checkedAttachCommand(command)).toBeNull();
  });
});

describe("controls: a valid command is a fresh copy in one key order", () => {
  const reversed = Object.fromEntries(Object.entries(SIG).reverse());
  it.each<[string, unknown]>([
    ["plain", COMMAND],
    ["other key order", { signature: reversed, payloadDigestSha256: DIGEST, receiptId: RECEIPT }],
    ["no prototype", Object.assign(Object.create(null) as object, COMMAND)],
    ["proxy without traps", new Proxy({ ...COMMAND, signature: reversed }, {})],
  ])("%s", (_name, command) => {
    const copy = checkedAttachCommand(command);
    expect(copy).toStrictEqual(COMMAND);
    expect(JSON.stringify(copy)).toBe(JSON.stringify(COMMAND));
    expect(copy).not.toBe(command);
    expect(copy?.signature).not.toBe((command as typeof COMMAND).signature);
  });
});
