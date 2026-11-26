// DAN-1563 acceptance: the intact package of the golden vectors passes, and
// every single change (a byte of a segment, a signature, the order, a left-out
// segment, the wrong key, a removed range, the Merkle proof) fails and names
// the place of the break. Invented data only: the golden vectors' invented
// segments, an ephemeral key made here and made-up receipt ids and digests.
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  canonicalizeJcs,
  digestEvidenceReceiptPayloadV2,
  evidenceLogInclusionProof,
  evidenceLogLeafHash,
  evidenceLogRoot,
  verifyCanonicalEvidencePayloadV2,
  type EvidenceReceiptPayloadV2,
  type EvidenceSegmentV2,
  type JcsJsonValue,
} from "../../server/domain/index.ts";
import { fromHex, loadGoldenVectors } from "../../server/domain/forensics/golden-vectors/index.ts";
import { createEditStepsV1Replayer } from "../../server/external/storage/index.ts";

import { CHAIN_MANIFEST, CHAIN_MANIFEST_FORMAT, CHAIN_USAGE, runChainVerify } from "./chain.ts";
import { readLocalFile } from "./index.ts";

const vectors = loadGoldenVectors();
const { chain } = vectors;
const utf8 = new TextEncoder();
const sha256 = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");

// Random version 4 UUIDs drawn for this test; they name no institution and no person.
const DOMAIN = "3b8f6c2e-9d41-4a57-b0e3-6f2a1c9d8e74";
const PRINCIPAL = "c7d2e9a1-4b6f-4e83-a1d5-92f0b3c6e7a8";
const KEY_ID = "dan-1563-cli-test-key";
const VALID_FROM = "2026-01-01T00:00:00.000Z";

type Signer = { privateKey: KeyObject; keyBase64Url: string };

function makeSigner(): Signer {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privateKey,
    keyBase64Url: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
  };
}

const trustedKey = (signer: Signer, set: Record<string, unknown> = {}) => ({
  algorithm: "Ed25519",
  keyId: KEY_ID,
  keyVersion: "1",
  encoding: "spki-der",
  keyBase64Url: signer.keyBase64Url,
  evidenceDomainId: DOMAIN,
  purpose: "receipt",
  validFrom: VALID_FROM,
  validTo: null,
  revokedAt: null,
  ...set,
});

/** A signed receipt v2 for each segment, bound to it as the server binds it. */
async function receiptsFor(segments: readonly Uint8Array[], signer: Signer) {
  const receipts: Record<string, unknown>[] = [];
  let previous: { hash: string; receiptId: string } | null = null;
  for (const [index, bytes] of segments.entries()) {
    const verified = await verifyCanonicalEvidencePayloadV2(bytes);
    if (!verified.ok) throw new Error("test segment is not canonical");
    const segment = verified.segment;
    const payload: EvidenceReceiptPayloadV2 = {
      receiptSchema: "ductus-evidence-receipt-v2",
      receiptId: `potvrda-izmisljena-${index + 1}`,
      evidenceDomainId: DOMAIN,
      evidencePackageId: chain.evidencePackageId,
      documentId: segment.documentId,
      revision: index + 1,
      clientTransactionId: `tx-izmisljena-${index + 1}`,
      principalId: PRINCIPAL,
      sessionId: segment.sessionId,
      segmentId: segment.segmentId,
      segmentHash: verified.sha256,
      predecessorSegmentHash: previous?.hash ?? null,
      previousReceiptId: previous?.receiptId ?? null,
      evidenceSchema: segment.evidenceSchema,
      evidenceProfileId: segment.evidenceProfileId,
      sequenceFrom: segment.sequenceFrom,
      sequenceTo: segment.sequenceTo,
      eventCount: segment.events.length,
      payloadBytes: verified.byteLength,
      acceptedAt: new Date(Date.parse("2026-10-12T08:45:00.000Z") + index * 60_000).toISOString(),
    };
    const digest = await digestEvidenceReceiptPayloadV2(payload);
    receipts.push({
      payload,
      payloadDigestSha256: digest.sha256,
      signature: {
        algorithm: "Ed25519",
        keyId: KEY_ID,
        keyVersion: "1",
        signatureEncoding: "raw",
        signatureBase64Url: sign(null, digest.signingInput, signer.privateKey).toString(
          "base64url",
        ),
      },
    });
    previous = { hash: verified.sha256, receiptId: payload.receiptId };
  }
  return receipts;
}

/** The Merkle file of a package; `leaves` null leaves only the inclusion proof. */
type MerkleProof = {
  receiptId: string;
  index: number;
  treeSize: number;
  root: string;
  proof: string[];
  leaves: string[] | null;
};

type Package = {
  segments: Uint8Array[];
  receipts: unknown[];
  head: { segmentHash: string; segmentCount: number } | null;
  initialDocument: JcsJsonValue | null;
  merkle: MerkleProof | null;
  keys: unknown;
  /** Names the manifest lists; by default every segment and receipt in order. */
  segmentNames?: string[];
  receiptNames?: string[];
};

/** The files of a package directory and of the keys file, by path. */
function filesOf(pkg: Package): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const segmentNames = pkg.segments.map((_, i) => `odsjecak-${i + 1}.json`);
  const receiptNames = pkg.receipts.map((_, i) => `potvrda-${i + 1}.json`);
  pkg.segments.forEach((bytes, i) => files.set(`paket/${segmentNames[i]}`, bytes));
  pkg.receipts.forEach((receipt, i) =>
    files.set(`paket/${receiptNames[i]}`, utf8.encode(JSON.stringify(receipt))),
  );
  if (pkg.initialDocument !== null) {
    files.set("paket/dokument-0.json", utf8.encode(JSON.stringify(pkg.initialDocument)));
  }
  if (pkg.merkle !== null) {
    files.set("paket/merkle-dokaz.json", utf8.encode(JSON.stringify(pkg.merkle)));
  }
  const manifest = {
    format: CHAIN_MANIFEST_FORMAT,
    segments: pkg.segmentNames ?? segmentNames,
    receipts: pkg.receiptNames ?? receiptNames,
    head: pkg.head,
    initialDocument: pkg.initialDocument === null ? null : "dokument-0.json",
    merkle: pkg.merkle === null ? null : "merkle-dokaz.json",
  };
  files.set(`paket/${CHAIN_MANIFEST}`, utf8.encode(JSON.stringify(manifest)));
  files.set("kljucevi.json", utf8.encode(JSON.stringify(pkg.keys)));
  return files;
}

function memoryIo(files: Map<string, Uint8Array>) {
  return {
    readFile: async (path: string, max: number) => {
      const bytes = files.get(path);
      if (bytes === undefined) return null;
      return bytes.byteLength > max ? ("too_large" as const) : bytes;
    },
    join: (directory: string, name: string) => `${directory}/${name}`,
  };
}

const ARGS = ["--chain", "paket", "--public-keys", "kljucevi.json"];
const check = (pkg: Package, argv: readonly string[] = ARGS) =>
  runChainVerify(argv, memoryIo(filesOf(pkg)));

// A day of three invented receipts and the two of this work, in log order.
async function merkleFor(
  receipts: readonly Record<string, unknown>[],
  pick: number,
): Promise<MerkleProof> {
  const other = (n: number) => sha256(`izmisljena tuda potvrda ${n}`);
  const leaves = [other(1), ...receipts.map((r) => r.payloadDigestSha256 as string), other(2)];
  const leafHashes = await Promise.all(leaves.map((leaf) => evidenceLogLeafHash(fromHex(leaf))));
  const index = 1 + pick;
  const proof = await evidenceLogInclusionProof(leafHashes, index);
  return {
    receiptId: (receipts[pick]!.payload as { receiptId: string }).receiptId,
    index,
    treeSize: leaves.length,
    root: Buffer.from(await evidenceLogRoot(leafHashes)).toString("hex"),
    proof: proof.map((p) => Buffer.from(p).toString("hex")),
    leaves,
  };
}

const goldenSegments = chain.segments.map((s) => fromHex(s.canonicalUtf8Hex));
const signer = makeSigner();
let intact: Package;

beforeAll(async () => {
  const receipts = await receiptsFor(goldenSegments, signer);
  intact = {
    segments: goldenSegments,
    receipts,
    head: chain.head,
    initialDocument: chain.documentStates[0]!.value,
    merkle: await merkleFor(receipts, 1),
    keys: [trustedKey(signer)],
  };
});

/** One byte of `bytes` replaced: the first occurrence of `find` by `replace`. */
function editBytes(bytes: Uint8Array, find: string, replace: string): Uint8Array {
  const text = new TextDecoder().decode(bytes);
  if (!text.includes(find)) throw new Error("test edit does not match");
  return utf8.encode(text.replace(find, replace));
}

describe("the evidence chain CLI (DAN-1563)", () => {
  it("passes the intact package of the golden vectors with exit code 0", async () => {
    const outcome = await check(intact);
    expect(outcome.problem).toBeNull();
    expect(outcome.exitCode).toBe(0);
    expect(outcome.summary).toStrictEqual({
      segments: 2,
      headSegmentHash: chain.head.segmentHash,
      receipts: 2,
      receiptKeyIds: [KEY_ID, KEY_ID],
      transactionFormat: "ductus-edit-steps-v1",
      finalDocumentSha256: chain.documentStates.at(-1)!.sha256,
      merkle: {
        receiptId: "potvrda-izmisljena-2",
        index: 2,
        treeSize: 4,
        root: intact.merkle!.root,
      },
    });
    expect(outcome.line).toMatch(/^ISPRAVNO: odsjecaka 2, glava a861531b/);
  });

  it("answers --json with one object and the same verdict", async () => {
    const ok = JSON.parse((await check(intact, [...ARGS, "--json"])).line);
    expect(ok).toMatchObject({ ok: true, problem: null, at: null, summary: { segments: 2 } });
    const broken = { ...intact, keys: [trustedKey(makeSigner())] };
    const bad = JSON.parse((await check(broken, ["--json", ...ARGS])).line);
    expect(bad).toStrictEqual({
      ok: false,
      problem: "receipt_refused",
      at: { segment: 1, sequence: null, detail: "signature_invalid" },
      summary: null,
    });
  });

  describe("a changed byte of a segment", () => {
    it("in the first segment breaks the link of the second", async () => {
      const segments = [editBytes(goldenSegments[0]!, "šumi", "šuma"), goldenSegments[1]!];
      const outcome = await check({ ...intact, segments });
      expect(outcome).toMatchObject({ exitCode: 1, problem: "predecessor_mismatch" });
      expect(outcome.at).toStrictEqual({ segment: 2, sequence: null, detail: null });
      expect(outcome.line).toBe("NEISPRAVNO: predecessor_mismatch (odsjecak 2)");
    });

    it("in the last segment breaks the recorded head", async () => {
      const segments = [goldenSegments[0]!, editBytes(goldenSegments[1]!, "Dio bez", "Dio sa ")];
      const outcome = await check({ ...intact, segments });
      expect(outcome).toMatchObject({ exitCode: 1, problem: "head_mismatch" });
    });

    it("that leaves non-canonical bytes is an invalid segment at its place", async () => {
      const segments = [
        editBytes(goldenSegments[0]!, '"sequence":1', '"sequence": 1'),
        goldenSegments[1]!,
      ];
      const outcome = await check({ ...intact, segments });
      expect(outcome).toMatchObject({ exitCode: 1, problem: "invalid_segment" });
      expect(outcome.at?.segment).toBe(1);
    });

    it("re-signed by the right key still fails the replay at its event", async () => {
      // The attacker holds the receipt key: chain, head and receipts agree, the steps do not.
      const segments = [goldenSegments[0]!, editBytes(goldenSegments[1]!, "Dio bez", "Dio sa ")];
      const verified = await verifyCanonicalEvidencePayloadV2(segments[1]!);
      if (!verified.ok) throw new Error("edited segment must stay canonical");
      const outcome = await check({
        ...intact,
        segments,
        receipts: await receiptsFor(segments, signer),
        head: { segmentHash: verified.sha256, segmentCount: 2 },
        merkle: null,
      });
      expect(outcome).toMatchObject({ exitCode: 1, problem: "document_hash_mismatch" });
      expect(outcome.at).toMatchObject({ segment: 2 });
      expect(outcome.at?.sequence).not.toBeNull();
    });
  });

  it("refuses a changed signature and names its segment", async () => {
    const receipts = structuredClone(intact.receipts) as Record<string, Record<string, string>>[];
    // A valid signature of the same key over other bytes than the D-92 signing input.
    receipts[1]!.signature!.signatureBase64Url = sign(
      null,
      utf8.encode("izmisljena druga poruka"),
      signer.privateKey,
    ).toString("base64url");
    const outcome = await check({ ...intact, receipts });
    expect(outcome).toMatchObject({ exitCode: 1, problem: "receipt_refused" });
    expect(outcome.at).toStrictEqual({ segment: 2, sequence: null, detail: "signature_invalid" });
  });

  it("refuses a changed signed field and names it", async () => {
    const receipts = structuredClone(intact.receipts) as Record<string, Record<string, unknown>>[];
    receipts[0]!.payload!.revision = 99;
    const outcome = await check({ ...intact, receipts });
    expect(outcome.at).toStrictEqual({ segment: 1, sequence: null, detail: "digest_mismatch" });
  });

  it("refuses segments in another order", async () => {
    const outcome = await check({
      ...intact,
      segments: [goldenSegments[1]!, goldenSegments[0]!],
      receipts: [intact.receipts[1], intact.receipts[0]],
    });
    expect(outcome).toMatchObject({ exitCode: 1, problem: "predecessor_mismatch" });
    expect(outcome.at?.segment).toBe(1);
  });

  it("refuses receipts in another order, bound to the wrong segment", async () => {
    const outcome = await check({ ...intact, receipts: [intact.receipts[1], intact.receipts[0]] });
    expect(outcome).toMatchObject({ exitCode: 1, problem: "receipt_segment_mismatch" });
    expect(outcome.at).toStrictEqual({ segment: 1, sequence: null, detail: "segmentHash" });
  });

  describe("a left-out segment", () => {
    it("at the start breaks the first link", async () => {
      const outcome = await check({
        ...intact,
        segments: [goldenSegments[1]!],
        receipts: [intact.receipts[1]],
      });
      expect(outcome).toMatchObject({ exitCode: 1, problem: "predecessor_mismatch" });
      expect(outcome.at?.segment).toBe(1);
    });

    it("at the end breaks the recorded head", async () => {
      const outcome = await check({
        ...intact,
        segments: [goldenSegments[0]!],
        receipts: [intact.receipts[0]],
      });
      expect(outcome).toMatchObject({ exitCode: 1, problem: "head_mismatch" });
    });

    it("with its receipt kept is a receipt count mismatch", async () => {
      const outcome = await check({ ...intact, receiptNames: ["potvrda-1.json"] });
      expect(outcome).toMatchObject({ exitCode: 1, problem: "receipt_count_mismatch" });
    });
  });

  describe("the wrong key", () => {
    it("another key under the same id fails the signature of the first receipt", async () => {
      const outcome = await check({ ...intact, keys: [trustedKey(makeSigner())] });
      expect(outcome.at).toStrictEqual({ segment: 1, sequence: null, detail: "signature_invalid" });
    });

    it("a key of another domain or purpose is out of scope", async () => {
      const otherDomain = "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d";
      for (const set of [{ evidenceDomainId: otherDomain }, { purpose: "checkpoint" }]) {
        const outcome = await check({ ...intact, keys: [trustedKey(signer, set)] });
        expect(outcome.at).toStrictEqual({ segment: 1, sequence: null, detail: "key_scope" });
      }
    });

    it("a revoked key vouches for nothing, and no key list is no key", async () => {
      const revoked = await check({
        ...intact,
        keys: [trustedKey(signer, { revokedAt: "2026-10-01T00:00:00.000Z" })],
      });
      expect(revoked.at?.detail).toBe("key_revoked");
      expect((await check({ ...intact, keys: [] })).at?.detail).toBe("key_unknown");
      expect((await check({ ...intact, keys: { keys: [] } })).problem).toBe("keys_invalid");
    });
  });

  describe("the replay with a removed range (B-12)", () => {
    const final = chain.documentStates.at(-1)!;
    const replayer = createEditStepsV1Replayer();

    /** A third invented segment that deletes positions 1..4 of the final document. */
    function deletion(removedSha256: string): Uint8Array {
      const document = replayer.load(final.value);
      const event = {
        sequence: 6,
        source: "editor" as const,
        steps: [{ stepType: "replace", from: 1, to: 4, removedSha256 }],
        beforeDocumentHash: final.sha256,
        afterDocumentHash: "",
      };
      const correct = sha256(canonicalizeJcs(document.slice(1, 4).toJSON() as JcsJsonValue));
      const after = replayer.apply(document, {
        ...event,
        steps: [{ ...event.steps[0]!, removedSha256: correct }],
      });
      event.afterDocumentHash = sha256(canonicalizeJcs(replayer.toCanonical(after)));
      const segment: EvidenceSegmentV2 = {
        ...(chain.segments[1]!.segment as EvidenceSegmentV2),
        sessionId: "sesija-izmisljena-zv-3",
        segmentId: "odsjecak-zv-3",
        sequenceFrom: 6,
        sequenceTo: 6,
        observedStartedAt: "2026-10-12T08:03:00.000Z",
        observedEndedAt: "2026-10-12T08:03:00.000Z",
        initialDocumentHash: final.sha256,
        finalDocumentHash: event.afterDocumentHash,
        predecessorSegmentHash: chain.head.segmentHash,
        events: [event],
      };
      return utf8.encode(canonicalizeJcs(segment as unknown as JcsJsonValue));
    }

    async function withThird(third: Uint8Array): Promise<Package> {
      const segments = [...goldenSegments, third];
      return {
        ...intact,
        segments,
        receipts: await receiptsFor(segments, signer),
        head: { segmentHash: sha256(third), segmentCount: 3 },
        merkle: null,
      };
    }

    it("passes a deletion whose removedSha256 is the hash of the removed range", async () => {
      const document = replayer.load(final.value);
      const correct = sha256(canonicalizeJcs(document.slice(1, 4).toJSON() as JcsJsonValue));
      const outcome = await check(await withThird(deletion(correct)));
      expect(outcome.problem).toBeNull();
      expect(outcome.summary).toMatchObject({ segments: 3, receipts: 3 });
    });

    it("fails a deletion whose removedSha256 is another hash, at its event", async () => {
      // Signed, chained and canonical: only the replay sees that the range is another text.
      const outcome = await check(await withThird(deletion(sha256("izmisljeni drugi tekst"))));
      expect(outcome).toMatchObject({ exitCode: 1, problem: "step_failed" });
      expect(outcome.at).toStrictEqual({ segment: 3, sequence: 6, detail: null });
      expect(outcome.line).toBe("NEISPRAVNO: step_failed (odsjecak 3, dogadaj 6)");
    });
  });

  it("names a record that does not start at the given starting document", async () => {
    // Without a starting document the replay starts at revision 0, which these segments do not.
    const outcome = await check({ ...intact, initialDocument: null });
    expect(outcome).toMatchObject({ exitCode: 1, problem: "record_break" });
    expect(outcome.at).toStrictEqual({ segment: 1, sequence: 1, detail: null });
  });

  describe("the daily Merkle root", () => {
    it("refuses a root that is not the root of the day's leaves", async () => {
      const merkle = { ...intact.merkle!, root: sha256("izmisljeni korijen") };
      expect((await check({ ...intact, merkle })).problem).toBe("merkle_root_mismatch");
      const leaves = [...(intact.merkle!.leaves as string[])].reverse();
      expect((await check({ ...intact, merkle: { ...intact.merkle!, leaves } })).problem).toBe(
        "merkle_root_mismatch",
      );
    });

    it("refuses a changed proof, index or size against the given root", async () => {
      // Without the day's leaves only the inclusion proof stands between the receipt and the root.
      const bare = { ...intact.merkle!, leaves: null };
      const proof = [...(bare.proof as string[])];
      proof[0] = sha256("izmisljeni cvor");
      for (const merkle of [
        { ...bare, proof },
        { ...bare, index: 1 },
        { ...bare, treeSize: 5 },
        { ...bare, proof: (bare.proof as string[]).slice(1) },
      ]) {
        expect((await check({ ...intact, merkle })).problem).toBe("merkle_inclusion_failed");
      }
      expect((await check({ ...intact, merkle: bare })).problem).toBeNull();
    });

    it("refuses a proof for a receipt the package does not hold", async () => {
      const merkle = { ...intact.merkle!, receiptId: "potvrda-koje-nema" };
      expect((await check({ ...intact, merkle })).problem).toBe("merkle_receipt_unknown");
    });

    it("says so when the package holds no proof", async () => {
      const outcome = await check({ ...intact, merkle: null });
      expect(outcome.exitCode).toBe(0);
      expect(outcome.line).toContain("Merkle dokaz nije u paketu");
    });
  });

  describe("bad and edge input", () => {
    it("gives the usage for wrong arguments", async () => {
      for (const argv of [
        [],
        ["--chain", "paket"],
        ["--chain", "paket", "--public-keys"],
        [...ARGS, "--chain", "paket"],
        ["--chain", "", "--public-keys", "kljucevi.json"],
        [...ARGS, "--json", "--json"],
        ["--root", "paket", "--public-keys", "kljucevi.json"],
      ]) {
        const outcome = await check(intact, argv);
        expect(outcome).toMatchObject({ exitCode: 1, problem: "usage", line: CHAIN_USAGE });
      }
    });

    it("never reads a name outside the package directory", async () => {
      for (const name of ["../kljucevi.json", "/etc/passwd", "..", "a/b.json"]) {
        const outcome = await check({ ...intact, segmentNames: [name, "odsjecak-2.json"] });
        expect(outcome.problem).toBe("manifest_invalid");
      }
    });

    it("refuses a missing file, a malformed manifest and a malformed receipt", async () => {
      const missing = await check({ ...intact, receiptNames: ["potvrda-1.json", "nema.json"] });
      expect(missing).toMatchObject({ problem: "file_unreadable", at: { segment: 2 } });

      const files = filesOf(intact);
      files.set(`paket/${CHAIN_MANIFEST}`, utf8.encode("{"));
      expect((await runChainVerify(ARGS, memoryIo(files))).problem).toBe("manifest_invalid");
      files.set(`paket/${CHAIN_MANIFEST}`, utf8.encode(JSON.stringify({ format: "drugi" })));
      expect((await runChainVerify(ARGS, memoryIo(files))).problem).toBe("manifest_invalid");

      const receipts = [intact.receipts[0], { payload: {} }];
      const malformed = await check({ ...intact, receipts });
      expect(malformed).toMatchObject({ problem: "receipt_malformed", at: { segment: 2 } });
    });

    it("passes an empty package only when the recorded head is empty too", async () => {
      const empty = { ...intact, segments: [], receipts: [], head: null, merkle: null };
      expect((await check(empty)).exitCode).toBe(0);
      expect((await check({ ...empty, head: chain.head })).problem).toBe("head_mismatch");
    });
  });
});

describe("the evidence chain CLI as a real process", () => {
  const CLI = fileURLToPath(new URL("./index.ts", import.meta.url));
  let directory: string;

  beforeAll(() => {
    directory = mkdtempSync(join(tmpdir(), "dan-1563-"));
    mkdirSync(join(directory, "paket"));
  });
  afterAll(() => rmSync(directory, { recursive: true, force: true }));

  function write(pkg: Package) {
    for (const [path, bytes] of filesOf(pkg)) writeFileSync(join(directory, path), bytes);
  }
  const run = (...extra: string[]) =>
    spawnSync(
      process.execPath,
      [
        CLI,
        "--chain",
        join(directory, "paket"),
        "--public-keys",
        join(directory, "kljucevi.json"),
        ...extra,
      ],
      { encoding: "utf8" },
    );

  it("exits 0 on the intact package and 1 on a changed one, offline", () => {
    write(intact);
    const ok = run();
    expect(ok.status).toBe(0);
    expect(ok.stdout).toMatch(/^ISPRAVNO: /);

    write({ ...intact, keys: [trustedKey(makeSigner())] });
    const bad = run("--json");
    expect(bad.status).toBe(1);
    expect(JSON.parse(bad.stdout)).toMatchObject({ ok: false, problem: "receipt_refused" });
  });

  it("reads files through the same reader as the other modes", async () => {
    write(intact);
    const outcome = await runChainVerify(
      ["--chain", join(directory, "paket"), "--public-keys", join(directory, "kljucevi.json")],
      { readFile: readLocalFile, join },
    );
    expect(outcome.exitCode).toBe(0);
  });
});
