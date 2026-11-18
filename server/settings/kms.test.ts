import { describe, expect, it } from "vitest";

import { kmsProblems, kmsSettings } from "./index.ts";

// DAN-963: the KMS signer's configuration. Accounts, key ids and the canary
// are invented; the canary stands in for anything that must not reach a log.
const CANARY = "invented-canary-963";
const UUID = "0f1e2d3c-4b5a-4978-8a6b-5c4d3e2f1a0b";
const KEY = `arn:aws:kms:eu-central-1:000000000000:key/${UUID}`;
const FULL = {
  DUCTUS_KMS_PROVIDER: "aws",
  DUCTUS_KMS_KEY_ID: KEY,
  DUCTUS_KMS_REGION: "eu-central-1",
};
const NAMES = Object.keys(FULL) as (keyof typeof FULL)[];
type Env = Record<string, string>;
const P = "DUCTUS_KMS_PROVIDER is not a known provider";
const K = "DUCTUS_KMS_KEY_ID is not a KMS key ARN";
const R = "DUCTUS_KMS_REGION is not an AWS region";
// CRLF, LF, tab, space, NBSP, DEL, NUL and the canary, before or after a valid value.
const NOISE = ["\r\n", "\n", "\t", " ", "\u00a0", "\u007f", "\u0000", CANARY];
const wrapped = (value: string) => NOISE.flatMap((noise) => [value + noise, noise + value]);

function refused(env: object, problem: string): void {
  const problems = kmsProblems(env as Env);
  expect(problems).toContain(problem);
  expect(problems.join(" ")).not.toContain(CANARY);
  expect(kmsSettings(env as Env)).toBeNull();
}

describe("kmsProblems: an incomplete configuration never starts", () => {
  it("names each missing or empty variable when 1 or 2 of 3 (or 3 empty) are set", () => {
    for (let mask = 0; mask < 7; mask++) {
      const env = Object.fromEntries(
        NAMES.map((name, i) => [name, mask & (1 << i) ? FULL[name] : ""]),
      );
      const missing = NAMES.filter((_, i) => !(mask & (1 << i)));
      expect(kmsProblems(env)).toEqual(missing.map((name) => `${name} is not set`));
      const absent = Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
      if (mask > 0) expect(kmsProblems(absent)).toEqual(kmsProblems(env));
    }
  });

  it.each([
    ...[...wrapped("aws"), " ", "AWS", "Aws", "\u0430ws", "gcp", "fake-kms"].map((v) => [
      "PROVIDER",
      v,
      P,
    ]),
    ...[
      ...wrapped(KEY),
      "alias/ductus-receipts",
      "arn:aws:kms:eu-central-1:000000000000:alias/ductus-receipts",
      UUID,
      KEY.replace(":kms:", ":s3:"),
      KEY.replace("arn:aws:", "arn:awsx:"),
      KEY.replace("000000000000", "00000000000"),
      KEY.replace("000000000000", "00000000000\uff10"),
      KEY.replace("0f1e2d3c", "0F1E2D3C"),
      KEY.replace(UUID, UUID.replaceAll("-", "")),
      KEY.replace(UUID, `mrk-${"A".repeat(32)}`),
      KEY.replace(UUID, `mrk-${"a".repeat(31)}`),
      `${KEY}/`,
      "C:\\keys\\ductus",
    ].map((v) => ["KEY_ID", v, K]),
    ...[
      ...wrapped("eu-central-1"),
      " ",
      "EU-CENTRAL-1",
      "eu-central",
      "eu_central_1",
      "eu-central-0",
    ].map((v) => ["REGION", v, R]),
  ])("refuses DUCTUS_KMS_%s %j", (name, value, problem) => {
    refused({ ...FULL, [`DUCTUS_KMS_${name}`]: value }, problem);
  });

  it("refuses a key ARN of another region than DUCTUS_KMS_REGION", () => {
    refused(
      { ...FULL, DUCTUS_KMS_REGION: "eu-west-1" },
      "DUCTUS_KMS_KEY_ID is not in DUCTUS_KMS_REGION",
    );
  });

  it("refuses a getter without calling it, and a value that is not a string", () => {
    let called = false;
    const env = { DUCTUS_KMS_PROVIDER: "aws", DUCTUS_KMS_REGION: "eu-central-1" };
    Object.defineProperty(env, "DUCTUS_KMS_KEY_ID", {
      enumerable: true,
      get: () => (called = true),
    });
    refused(env, K);
    expect(called).toBe(false);
    refused({ ...FULL, DUCTUS_KMS_REGION: 1 }, R);
  });

  it("does not count inherited keys: inherited only is unset, inherited with own is incomplete", () => {
    const inherited = Object.create(FULL) as Env;
    expect([kmsProblems(inherited), kmsSettings(inherited)]).toEqual([[], null]);
    refused(
      Object.assign(Object.create(FULL) as object, { DUCTUS_KMS_PROVIDER: "aws" }),
      "DUCTUS_KMS_KEY_ID is not set",
    );
    for (const key of ["toString", "__proto__", "constructor", "hasOwnProperty"]) {
      expect(kmsProblems(JSON.parse(`{"${key}":"aws"}`) as Env)).toEqual([]);
    }
  });
});

describe("kmsProblems and kmsSettings: an absent or complete configuration", () => {
  it("is silent and selects nothing when no KMS variable is set, in production too", () => {
    for (const env of [{}, { NODE_ENV: "production" }, { NODE_ENV: "test" }]) {
      expect([kmsProblems(env), kmsSettings(env)]).toEqual([[], null]);
    }
  });

  it.each([
    [KEY, "eu-central-1"],
    [KEY.replace(UUID, `mrk-${"0123456789abcdef".repeat(2)}`), "eu-central-1"],
    [`arn:aws-us-gov:kms:us-gov-west-1:000000000000:key/${UUID}`, "us-gov-west-1"],
    [`arn:aws-cn:kms:cn-north-1:000000000000:key/${UUID}`, "cn-north-1"],
  ])("selects aws with the key %s", (keyId, region) => {
    const env = {
      NODE_ENV: "production",
      ...FULL,
      DUCTUS_KMS_KEY_ID: keyId,
      DUCTUS_KMS_REGION: region,
    };
    expect(kmsProblems(env)).toEqual([]);
    const settings = kmsSettings(env);
    expect(settings).toEqual({ provider: "aws", keyId, region });
    expect(Object.isFrozen(settings)).toBe(true);
  });
});
