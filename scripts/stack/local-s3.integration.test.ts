// DAN-817, plan of attack ductura/server#129 (S1-S9, P1, P3): the local S3 of
// the VS-1 stack, with the production adapter S3EvidencePayloadStore as its
// contract test, over a real loopback socket and a temporary directory.
import { createHash, createHmac } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { request as httpRequest } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  EvidenceStorageConfigError,
  InstitutionRoutedPayloadStore,
  loadEvidenceStorageConfig,
  S3EvidencePayloadStore,
  S3SecretCredentials,
  STORAGE_IDENTITY_KEY,
} from "../../server/external/storage/index.ts";
import { localS3Config, localS3Server, MAX_OBJECT_BYTES } from "./local-s3.ts";

// Invented values only; the key is made for each run.
const INSTITUTION = "00000000-0000-4000-8000-00000000000a";
const OTHER = "00000000-0000-4000-8000-00000000000b";
const PACKAGE = "paket-izmisljeni-1";
const BUCKET = "ductus-evidence-demo-fakultet";
const REGION = "us-east-1";
const KEY_ID = `vs1${Math.random().toString(36).slice(2, 12)}`;
const SECRET = `s${Math.random().toString(36).slice(2)}${Math.random().toString(36).slice(2)}`;

let root: string;
let endpoint: string;
let close: () => Promise<void>;

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), "vs1-s3-"));
  const server = localS3Server({
    root,
    bucket: BUCKET,
    region: REGION,
    accessKeyId: KEY_ID,
    secretAccessKey: SECRET,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});

afterEach(async () => {
  await close();
  rmSync(root, { recursive: true, force: true });
});

const capability = () => ({
  provider: "vs1-local-s3",
  endpoint,
  conditionalWrite: "verified" as const,
  checksumEcho: "verified" as const,
  verifiedOn: "2026-11-16",
  contractTest: "scripts-stack-local-s3.integration",
});

function store(secret = SECRET) {
  const warn = vi.fn();
  return new S3EvidencePayloadStore({
    endpoint,
    region: REGION,
    bucket: BUCKET,
    storageDomain: "local-demo-fakultet",
    credentials: new S3SecretCredentials({ accessKeyId: KEY_ID, secretAccessKey: secret }),
    capability: capability(),
    requestTimeoutMs: 5000,
    allowPlainHttpOnLoopback: true,
    warn,
  });
}

const segment = (text: string) => {
  const canonicalPayload = JSON.stringify({ tekst: text });
  return {
    institutionId: INSTITUTION,
    evidencePackageId: PACKAGE,
    segmentHash: createHash("sha256").update(canonicalPayload).digest("hex"),
    canonicalPayload,
  };
};

const sha = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest();
const mac = (key: Uint8Array | string, value: string) =>
  createHmac("sha256", key).update(value, "utf8").digest();

/**
 * SigV4 written here again, apart from the adapter's signer, so the local S3
 * is checked against the published algorithm and not against itself. Every
 * given header is signed; `extra` headers are signed as given.
 */
function signedOver(
  method: "GET" | "HEAD" | "PUT",
  path: string[],
  extra: Record<string, string>,
  body = new Uint8Array(),
  credentials = { accessKeyId: KEY_ID, secretAccessKey: SECRET },
) {
  const url = new URL(`/${path.join("/")}`, endpoint);
  const amzDate = new Date()
    .toISOString()
    .replace(/[-:]/gu, "")
    .replace(/\.\d{3}/u, "");
  const day = amzDate.slice(0, 8);
  const payload = sha(body).toString("hex");
  const headers: Record<string, string> = {
    ...extra,
    "x-amz-date": amzDate,
    "x-amz-content-sha256": payload,
  };
  const all: Record<string, string> = { ...headers, host: url.host };
  const names = Object.keys(all).sort();
  const canonical = [
    method,
    url.pathname,
    "",
    names.map((name) => `${name}:${all[name]}\n`).join(""),
    names.join(";"),
    payload,
  ].join("\n");
  const scope = `${day}/${REGION}/s3/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha(canonical).toString("hex")].join("\n");
  let key = mac(`AWS4${credentials.secretAccessKey}`, day);
  for (const part of [REGION, "s3", "aws4_request"]) key = mac(key, part);
  const signature = createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  headers.authorization =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${names.join(";")}, Signature=${signature}`;
  return { url: url.href, headers };
}

/** One request signed as the adapter signs it: a PUT is create-only with its checksum. */
function signed(
  method: "GET" | "HEAD" | "PUT",
  path: string[],
  body = new Uint8Array(),
  credentials = { accessKeyId: KEY_ID, secretAccessKey: SECRET },
) {
  const extra: Record<string, string> =
    method === "PUT"
      ? { "if-none-match": "*", "x-amz-checksum-sha256": sha(body).toString("base64") }
      : {};
  return signedOver(method, path, extra, body, credentials);
}

async function send(
  method: string,
  url: string,
  headers: Record<string, string>,
  body?: Uint8Array,
) {
  const response = await fetch(url, { method, headers, ...(body ? { body } : {}) });
  return { status: response.status, text: await response.text(), headers: response.headers };
}

/** A raw request: the path goes out exactly as written, never normalized by URL. */
function raw(path: string, headers: Record<string, string>): Promise<number> {
  const { port } = new URL(endpoint);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      res.resume();
      resolve(res.statusCode ?? 0);
    });
    req.once("error", reject);
    req.end();
  });
}

const files = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

describe("the local S3 under the production adapter (S9)", () => {
  it("stores, finds the same bytes again, and refuses other bytes under the key", async () => {
    const s3 = store();
    const first = segment("prvi");
    expect(await s3.putImmutable(first)).toMatchObject({ status: "stored" });
    expect(await s3.putImmutable(first)).toMatchObject({ status: "existing" });
    const other = { ...first, canonicalPayload: JSON.stringify({ tekst: "drugi" }) };
    // Another payload under the same hash is refused by the adapter first.
    expect(await s3.putImmutable(other)).toEqual({ status: "invalid" });
    const read = await s3.readImmutable(first);
    expect(read.status).toBe("found");
    const bytes = new TextEncoder().encode(first.canonicalPayload);
    expect(await s3.headImmutable({ ...first, payloadBytes: bytes.byteLength })).toEqual({
      status: "present",
    });
    expect(await s3.readImmutable({ ...first, segmentHash: "a".repeat(64) })).toEqual({
      status: "not_found",
    });
    expect(
      await s3.headImmutable({ ...first, segmentHash: "a".repeat(64), payloadBytes: 3 }),
    ).toEqual({ status: "absent" });
  });

  it("answers conflict when the key holds other bytes (S3)", async () => {
    const first = segment("treći");
    const key = ["v2", INSTITUTION, PACKAGE, `${first.segmentHash}.json`];
    const dir = join(root, BUCKET, ...key.slice(0, -1));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, key[3] ?? ""), "drugi bajtovi");
    expect(await store().putImmutable(first)).toEqual({ status: "conflict" });
  });

  it("verifies the bucket identity label, and refuses another institution's", async () => {
    mkdirSync(join(root, BUCKET));
    writeFileSync(
      join(root, BUCKET, STORAGE_IDENTITY_KEY),
      JSON.stringify({ institutionId: INSTITUTION, region: REGION }),
    );
    expect(await store().verifyIdentity({ institutionId: INSTITUTION })).toEqual({
      status: "verified",
    });
    expect(await store().verifyIdentity({ institutionId: OTHER })).toEqual({ status: "mismatch" });
  });

  it("never stores with a wrong key (S2)", async () => {
    const outcome = await store(`${SECRET}x`).putImmutable(segment("četvrti"));
    expect(outcome).toEqual({ status: "unavailable", reason: "storage_signature_rejected" });
    expect(files(root)).toEqual([]);
  });

  it("two writes of one key at once store it once (S7)", async () => {
    const s3 = store();
    const one = segment("istodobno");
    const outcomes = await Promise.all([s3.putImmutable(one), s3.putImmutable(one)]);
    expect(outcomes.map((o) => o.status).sort()).toEqual(["existing", "stored"]);
    expect(files(root)).toHaveLength(1);
  });
});

describe("requests the adapter never sends (S2-S6, S8)", () => {
  const path = [BUCKET, "objekt.json"];
  const body = new TextEncoder().encode('{"a":1}');

  it("refuses a missing, foreign or altered signature", async () => {
    const good = signed("PUT", path, body);
    const url = good.url;
    const without = Object.fromEntries(
      Object.entries(good.headers).filter(([name]) => name.toLowerCase() !== "authorization"),
    );
    expect((await send("PUT", url, without, body)).status).toBe(403);
    const foreign = signed("PUT", path, body, { accessKeyId: "drugi", secretAccessKey: SECRET });
    const refused = await send("PUT", url, foreign.headers, body);
    expect(refused.status).toBe(403);
    expect(refused.text).toContain("InvalidAccessKeyId");
    // A signed header changed after signing.
    const altered = { ...good.headers, "x-amz-date": "20261116T000000Z" };
    expect((await send("PUT", url, altered, body)).status).toBe(403);
    // Another body under the signed hash.
    const other = new TextEncoder().encode('{"a":2}');
    expect((await send("PUT", url, good.headers, other)).status).toBe(400);
    expect(files(root)).toEqual([]);
  });

  it("refuses a PUT that is not create-only and a checksum of other bytes", async () => {
    const good = signed("PUT", path, body);
    // Dropping or changing a create-only header breaks the adapter's signature.
    const plain = Object.fromEntries(
      Object.entries(good.headers).filter(([name]) => name.toLowerCase() !== "if-none-match"),
    );
    expect((await send("PUT", good.url, plain, body)).status).toBe(403);
    const checksum = { ...good.headers, "x-amz-checksum-sha256": `${"A".repeat(43)}=` };
    expect((await send("PUT", good.url, checksum, body)).status).toBe(403);
    // Validly signed by another client: still never an overwrite or a wrong checksum.
    const sum = createHash("sha256").update(body).digest("base64");
    const unconditional = signedOver(
      "PUT",
      path,
      { "if-none-match": "x", "x-amz-checksum-sha256": sum },
      body,
    );
    expect((await send("PUT", unconditional.url, unconditional.headers, body)).status).toBe(501);
    const wrong = signedOver(
      "PUT",
      path,
      { "if-none-match": "*", "x-amz-checksum-sha256": `${"A".repeat(43)}=` },
      body,
    );
    const bad = await send("PUT", wrong.url, wrong.headers, body);
    expect(bad.status).toBe(400);
    expect(bad.text).toContain("BadDigest");
    expect(files(root)).toEqual([]);
    const right = signedOver(
      "PUT",
      path,
      { "if-none-match": "*", "x-amz-checksum-sha256": sum },
      body,
    );
    expect((await send("PUT", right.url, right.headers, body)).status).toBe(200);
    expect((await send("PUT", right.url, right.headers, body)).status).toBe(412);
  });

  it("refuses a body over the limit without storing it (S6)", async () => {
    const large = new Uint8Array(MAX_OBJECT_BYTES + 1);
    const request = signed("PUT", path, large);
    const got = await send("PUT", request.url, request.headers, large).catch(() => ({
      status: 0,
    }));
    expect([0, 400]).toContain(got.status);
    expect(files(root)).toEqual([]);
  });

  it.each([
    "/../etc/passwd",
    "/%2e%2e/x",
    `/${BUCKET}/..%2fx`,
    `/${BUCKET}//x`,
    `/${BUCKET}/x?versionId=1`,
    `/${BUCKET}/./x`,
    `/${BUCKET}/a%20b`,
    `/${BUCKET}/x#y`,
  ])("refuses the path %s before reading anything", async (path) => {
    const request = signed("GET", [BUCKET, "x"]);
    expect(await raw(path, request.headers)).toBe(400);
  });

  it("answers NoSuchBucket for another bucket and NoSuchKey for a missing key", async () => {
    const other = signed("GET", ["drugi-bucket", "x"]);
    expect((await send("GET", other.url, other.headers)).text).toContain("NoSuchBucket");
    const missing = signed("GET", [BUCKET, "nema.json"]);
    const got = await send("GET", missing.url, missing.headers);
    expect(got.status).toBe(404);
    expect(got.text).toContain("<Code>NoSuchKey</Code>");
  });

  it("never follows a link in the storage directory (S5)", async () => {
    const outside = mkdtempSync(join(tmpdir(), "vs1-s3-outside-"));
    try {
      writeFileSync(join(outside, "tajna.json"), "{}");
      mkdirSync(join(root, BUCKET));
      symlinkSync(outside, join(root, BUCKET, "veza"));
      symlinkSync(join(outside, "tajna.json"), join(root, BUCKET, "datoteka.json"));
      for (const key of [["veza", "tajna.json"], ["datoteka.json"]]) {
        const request = signed("GET", [BUCKET, ...key]);
        expect((await send("GET", request.url, request.headers)).status).toBe(500);
      }
      const put = signed("PUT", [BUCKET, "veza", "novo.json"], body);
      expect((await send("PUT", put.url, put.headers, body)).status).toBe(500);
      expect(readdirSync(outside)).toEqual(["tajna.json"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("production never reaches the local S3 (P1, P3)", () => {
  const env = (nodeEnv: string | undefined) => ({
    NODE_ENV: nodeEnv,
    EVIDENCE_S3_VS1_KEY_ID: KEY_ID,
    EVIDENCE_S3_VS1_SECRET: SECRET,
    EVIDENCE_STORAGE_DOMAINS: JSON.stringify({
      requestTimeoutMs: 5000,
      domains: [
        {
          label: "local-demo-fakultet",
          institutionId: INSTITUTION,
          endpoint,
          region: REGION,
          bucket: BUCKET,
          accessKeyIdVar: "EVIDENCE_S3_VS1_KEY_ID",
          secretAccessKeyVar: "EVIDENCE_S3_VS1_SECRET",
          capability: capability(),
        },
      ],
    }),
  });

  afterEach(() => vi.unstubAllEnvs());

  it("the stack's storage configuration builds under development", () => {
    const config = loadEvidenceStorageConfig(env("development"));
    expect(() =>
      InstitutionRoutedPayloadStore.fromConfig(config, { allowPlainHttpOnLoopback: true }),
    ).not.toThrow();
  });

  it("under NODE_ENV production the same configuration is refused before any request", () => {
    vi.stubEnv("NODE_ENV", "production");
    const fetch = vi.fn();
    const config = loadEvidenceStorageConfig(env("production"));
    // Even a caller that asks for plain http on loopback gets none in production.
    expect(() =>
      InstitutionRoutedPayloadStore.fromConfig(config, { allowPlainHttpOnLoopback: true, fetch }),
    ).toThrow(EvidenceStorageConfigError);
    expect(fetch).not.toHaveBeenCalled();
    expect(files(root)).toEqual([]);
  });

  it.each(["production", "", undefined, "Production", " test", "dev"])(
    "the local S3 refuses to start with NODE_ENV %j",
    (nodeEnv) => {
      expect(() =>
        localS3Config({
          NODE_ENV: nodeEnv,
          PORT: "4190",
          VS1_S3_ROOT: root,
          VS1_S3_BUCKET: BUCKET,
          VS1_S3_REGION: REGION,
          EVIDENCE_S3_VS1_KEY_ID: KEY_ID,
          EVIDENCE_S3_VS1_SECRET: SECRET,
        }),
      ).toThrow(/NODE_ENV/u);
    },
  );

  it("its configuration errors name variables, never a value", () => {
    let message = "";
    try {
      localS3Config({
        NODE_ENV: "test",
        PORT: "4190",
        VS1_S3_ROOT: root,
        VS1_S3_BUCKET: BUCKET,
        VS1_S3_REGION: REGION,
        EVIDENCE_S3_VS1_KEY_ID: KEY_ID,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("EVIDENCE_S3_VS1_SECRET is not set");
    expect(message).not.toContain(KEY_ID);
  });
});
