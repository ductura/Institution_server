import { generateKeyPairSync, sign as nodeSign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  canonicalizeJcs,
  digestEvidenceReceiptPayloadV2,
  type EvidenceDomainKey,
  evidenceLogInclusionProof,
  evidenceLogLeafHash,
  evidenceLogRoot,
  type EvidenceReceiptPayloadV2,
  type SignedEvidenceReceiptV2,
} from "../../server/domain/index.ts";
import {
  fromHex,
  loadGoldenVectors,
  toHex,
} from "../../server/domain/forensics/golden-vectors/index.ts";
import { formatReport, main } from "./cli.ts";
import {
  EVIDENCE_VERIFY_PACKAGE_SCHEMA,
  type EvidenceVerifyPackage,
  type EvidenceVerifyTrust,
  verifyEvidencePackage,
} from "./index.ts";

/**
 * DAN-1563. The package is the two golden chain segments with receipts signed
 * here by a key made for this file; the golden vectors hold no private key.
 * Each test changes one thing in a package that passes and names the check
 * and the segment that must report it. All data is invented.
 */

const { chain, receiptV2 } = loadGoldenVectors();
const DOMAIN = receiptV2.evidenceDomainId;
const KEY_ID = "kljuc-izmisljeni-provjera";
const pair = generateKeyPairSync("ed25519");
const other = generateKeyPairSync("ed25519");
const spki = (key: typeof pair.publicKey) =>
  key.export({ type: "spki", format: "der" }).toString("base64url");
const trustedKey = (keyBase64Url: string): EvidenceDomainKey => ({
  algorithm: "Ed25519",
  keyId: KEY_ID,
  keyVersion: "1",
  encoding: "spki-der",
  keyBase64Url,
  ...receiptV2.keyEntry,
});
const PREFIX = Buffer.from("ductus-evidence-receipt-v2\n", "utf8");
const text = (index: number) =>
  Buffer.from(chain.segments[index]!.canonicalUtf8Hex, "hex").toString("utf8");

async function receipt(
  index: number,
  change: Partial<EvidenceReceiptPayloadV2> = {},
): Promise<SignedEvidenceReceiptV2> {
  const { segment, segmentHash, byteLength } = chain.segments[index]!;
  const payload: EvidenceReceiptPayloadV2 = {
    receiptSchema: "ductus-evidence-receipt-v2",
    receiptId: `potvrda-izmisljena-${index + 1}`,
    evidenceDomainId: DOMAIN,
    evidencePackageId: chain.evidencePackageId,
    documentId: segment.documentId,
    revision: index + 1,
    clientTransactionId: `tx-izmisljeni-${index + 1}`,
    principalId: receiptV2.principalId,
    sessionId: segment.sessionId,
    segmentId: segment.segmentId,
    segmentHash,
    predecessorSegmentHash: segment.predecessorSegmentHash,
    previousReceiptId: index === 0 ? null : `potvrda-izmisljena-${index}`,
    evidenceSchema: segment.evidenceSchema,
    evidenceProfileId: segment.evidenceProfileId,
    sequenceFrom: segment.sequenceFrom,
    sequenceTo: segment.sequenceTo,
    eventCount: segment.events.length,
    payloadBytes: byteLength,
    acceptedAt: `2026-10-12T08:0${index + 3}:00.000Z`,
    ...change,
  };
  const digest = await digestEvidenceReceiptPayloadV2(payload);
  expect(digest.canonical).toBe(canonicalizeJcs(payload));
  return {
    payload,
    payloadDigestSha256: digest.sha256,
    signature: {
      algorithm: "Ed25519",
      keyId: KEY_ID,
      keyVersion: "1",
      signatureEncoding: "raw",
      signatureBase64Url: nodeSign(
        null,
        Buffer.concat([PREFIX, fromHex(digest.sha256)]),
        pair.privateKey,
      ).toString("base64url"),
    },
  };
}

async function valid(): Promise<{ pkg: EvidenceVerifyPackage; trust: EvidenceVerifyTrust }> {
  const receipts = [await receipt(0), await receipt(1)];
  const leaves = await Promise.all(
    receipts.map((entry) => evidenceLogLeafHash(fromHex(entry.payloadDigestSha256))),
  );
  const inclusions = await Promise.all(
    leaves.map(async (_, index) => ({
      index,
      proofHex: (await evidenceLogInclusionProof(leaves, index)).map(toHex),
    })),
  );
  return {
    pkg: {
      packageSchema: EVIDENCE_VERIFY_PACKAGE_SCHEMA,
      segments: [text(0), text(1)],
      receipts,
      inclusions,
    },
    trust: {
      evidenceDomainId: DOMAIN,
      keys: [trustedKey(spki(pair.publicKey))],
      log: { treeSize: 2, rootHex: toHex(await evidenceLogRoot(leaves)) },
    },
  };
}

const statusOf = async (pkg: unknown, trust: unknown) => {
  const report = await verifyEvidencePackage(pkg, trust);
  return { ok: report.ok, failed: report.checks.filter((check) => check.status === "failed") };
};

describe("verifyEvidencePackage", () => {
  it("passes a whole package and says what it did not check", async () => {
    const { pkg, trust } = await valid();
    const report = await verifyEvidencePackage(pkg, trust);
    expect(report.ok).toBe(true);
    expect(report.checks.map((check) => `${check.check}:${check.status}`)).toEqual([
      "package:ok",
      "chain:ok",
      "receipts:ok",
      "log:ok",
      "replay:skipped",
    ]);
  });

  it("skips the log without a root and fails it when the proofs are missing", async () => {
    const { pkg, trust } = await valid();
    const { log, ...noLog } = trust;
    const withoutRoot = await verifyEvidencePackage(pkg, noLog);
    expect(withoutRoot.ok).toBe(true);
    expect(withoutRoot.checks[3]).toEqual({
      check: "log",
      status: "skipped",
      reason: "no_log_root",
    });
    const { inclusions, ...noProofs } = pkg;
    expect(inclusions).toHaveLength(2);
    expect(log).toBeDefined();
    expect((await statusOf(noProofs, trust)).failed).toEqual([
      { check: "log", status: "failed", reason: "no_inclusion_proofs" },
    ]);
  });

  it("names the segment whose bytes were changed after signing", async () => {
    const { pkg, trust } = await valid();
    const changed = text(1).replace('"sequenceFrom":3', '"sequenceFrom":4');
    expect(changed).not.toBe(text(1));
    const result = await statusOf({ ...pkg, segments: [text(0), changed] }, trust);
    expect(result.ok).toBe(false);
    expect(result.failed[1]).toMatchObject({ check: "receipts", index: 1 });
  });

  it("refuses a changed signature, a foreign key and a foreign domain", async () => {
    const { pkg, trust } = await valid();
    const first = pkg.receipts[0] as SignedEvidenceReceiptV2;
    const forged = {
      ...first,
      signature: {
        ...first.signature,
        signatureBase64Url: nodeSign(
          null,
          Buffer.concat([PREFIX, fromHex(first.payloadDigestSha256)]),
          other.privateKey,
        ).toString("base64url"),
      },
    };
    expect(
      (await statusOf({ ...pkg, receipts: [forged, pkg.receipts[1]] }, trust)).failed[1],
    ).toEqual({
      check: "receipts",
      status: "failed",
      reason: "signature_invalid",
      index: 0,
    });
    const foreignKey = { ...trust, keys: [trustedKey(spki(other.publicKey))] };
    expect((await statusOf(pkg, foreignKey)).failed[1]).toMatchObject({
      check: "receipts",
      reason: "signature_invalid",
      index: 0,
    });
    const foreignDomain = { ...trust, evidenceDomainId: receiptV2.otherEvidenceDomainId };
    expect((await statusOf(pkg, foreignDomain)).failed[1]).toMatchObject({
      check: "receipts",
      reason: "domain_mismatch",
      index: 0,
    });
  });

  it("refuses a validly signed receipt of another segment", async () => {
    const { pkg, trust } = await valid();
    const receipts = [pkg.receipts[0], await receipt(1, { payloadBytes: 1 })];
    expect((await statusOf({ ...pkg, receipts }, trust)).failed[1]).toEqual({
      check: "receipts",
      status: "failed",
      reason: "segment_mismatch",
      index: 1,
    });
  });

  it("refuses swapped and missing segments", async () => {
    const { pkg, trust } = await valid();
    const { log, ...noLog } = trust;
    expect(log).toBeDefined();
    const swapped = {
      packageSchema: pkg.packageSchema,
      segments: [text(1), text(0)],
      receipts: [pkg.receipts[1], pkg.receipts[0]],
    };
    expect((await statusOf(swapped, noLog)).failed).toEqual([
      { check: "chain", status: "failed", reason: "predecessor_mismatch", index: 0 },
    ]);
    const headless = {
      packageSchema: pkg.packageSchema,
      segments: [text(1)],
      receipts: [pkg.receipts[1]],
    };
    expect((await statusOf(headless, noLog)).failed).toEqual([
      { check: "chain", status: "failed", reason: "predecessor_mismatch", index: 0 },
    ]);
    expect((await statusOf({ ...pkg, segments: [text(0)] }, trust)).failed).toEqual([
      { check: "package", status: "failed", reason: "package_malformed" },
    ]);
  });

  it("refuses a proof that does not lead to the trusted root", async () => {
    const { pkg, trust } = await valid();
    const inclusions = [pkg.inclusions![0]!, { index: 1, proofHex: ["0".repeat(64)] }];
    expect((await statusOf({ ...pkg, inclusions }, trust)).failed).toEqual([
      { check: "log", status: "failed", reason: "not_in_log", index: 1 },
    ]);
    const otherRoot = { ...trust, log: { treeSize: 2, rootHex: "1".repeat(64) } };
    expect((await statusOf(pkg, otherRoot)).failed[0]).toMatchObject({ check: "log", index: 0 });
  });

  it("refuses a malformed trust file before reading the package", async () => {
    const { pkg } = await valid();
    expect((await statusOf(pkg, { evidenceDomainId: "nije-uuid", keys: [] })).failed).toEqual([
      { check: "package", status: "failed", reason: "trust_malformed" },
    ]);
  });
});

describe("evidence:verify", () => {
  const dir = mkdtempSync(join(tmpdir(), "evidence-verify-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, value: unknown) => {
    const path = join(dir, name);
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
    return path;
  };

  it("exits 0 for a whole package, 1 for a changed one and 2 for bad input", async () => {
    const { pkg, trust } = await valid();
    const trustPath = write("trust.json", trust);
    const good = await main([write("good.json", pkg), trustPath]);
    expect(good.code).toBe(0);
    expect(good.output).toContain("Ponovno izvođenje koraka: NIJE PROVJERENO (no_step_replayer)");
    const bad = await main([
      write("bad.json", { ...pkg, segments: [text(1), text(0)] }),
      trustPath,
      "--json",
    ]);
    expect(bad.code).toBe(1);
    expect((JSON.parse(bad.output) as { ok: boolean }).ok).toBe(false);
    expect((await main([trustPath])).code).toBe(2);
    expect((await main([write("broken.json", "{"), trustPath])).code).toBe(2);
    expect((await main([join(dir, "nema.json"), trustPath])).code).toBe(2);
  });

  it("names the segment in the text report, counted from one", () => {
    const report = formatReport({
      ok: false,
      checks: [{ check: "chain", status: "failed", reason: "predecessor_mismatch", index: 1 }],
    });
    expect(report).toBe(
      "Lanac odsječaka: NIJE U REDU (predecessor_mismatch, odsječak 2)\nIshod: zapis nije potvrđen.\n",
    );
  });
});
