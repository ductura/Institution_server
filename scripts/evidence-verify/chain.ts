// DAN-1563: the offline check of the evidence chain of one work, from files,
// with the same CLI as the daily root (SRV-1311) and the portable record:
//   node scripts/evidence-verify/index.ts --chain <directory> --public-keys keys.json [--json]
// No network, no database. Every check is an existing function of
// server/domain/forensics (and the server's own step replayer, which checks
// each removed range against its removedSha256, B-12); this file only reads
// the files, calls them in order and binds each receipt to its segment.
// Exit code 0 only when everything holds; a failure names a closed code and
// the place of the break, never an input value.
import {
  EDIT_STEP_FORMAT_V1,
  EDIT_STEP_FORMAT_V3,
  evidenceLogLeafHash,
  evidenceLogRoot,
  findEvidenceStartBreakV2,
  isSignedEvidenceReceiptV2,
  MAX_EVIDENCE_SEGMENT_BYTES,
  replayEvidenceSegmentsV2,
  REVISION_ZERO_JCS,
  REVISION_ZERO_V3_JCS,
  verifyCanonicalEvidencePayloadV2,
  verifyEvidenceChainV2,
  verifyEvidenceLogInclusion,
  verifySignedEvidenceReceiptV2,
  type EvidenceChainHeadV2,
  type EvidenceDomainKey,
  type EvidenceReplayResultV2,
  type EvidenceSegment,
  type EvidenceStepReplayerV2,
  type JcsJsonValue,
  type SignedEvidenceReceiptV2,
  type VerifiedEvidencePayloadV2,
} from "../../server/domain/index.ts";
import {
  createEditStepsV1Replayer,
  createEditStepsV3Replayer,
} from "../../server/external/storage/index.ts";

import type { JoinPath } from "./portable-record.ts";
import type { ReadFile } from "./verify.ts";

export const CHAIN_USAGE =
  "Upotreba: node scripts/evidence-verify/index.ts --chain <mapa> --public-keys kljucevi.json [--json]";

/** The manifest of a package directory; it names every other file. */
export const CHAIN_MANIFEST = "paket.json";
export const CHAIN_MANIFEST_FORMAT = "ductura-evidence-chain-v1";

/** Upper bounds, asked before a file is parsed. */
export const MAX_CHAIN_SEGMENTS = 10_000;
export const MAX_MANIFEST_BYTES = 4 * 1024 * 1024;
export const MAX_KEYS_FILE_BYTES = 1024 * 1024;
export const MAX_RECEIPT_FILE_BYTES = 64 * 1024;
export const MAX_DOCUMENT_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_MERKLE_FILE_BYTES = 64 * 1024 * 1024;

export type ChainProblem =
  | "usage"
  | "file_unreadable"
  | "file_too_large"
  | "manifest_invalid"
  | "keys_invalid"
  // verifyEvidenceChainV2
  | "too_large"
  | "invalid_segment"
  | "predecessor_mismatch"
  | "document_mismatch"
  | "head_mismatch"
  // a break in event numbers or document hash, also before the first segment
  | "record_break"
  // receipts
  | "receipt_count_mismatch"
  | "receipt_malformed"
  | "receipt_refused"
  | "receipt_segment_mismatch"
  // replayEvidenceSegmentsV2
  | "unsupported_format"
  | "invalid_document"
  | "step_failed"
  | "document_hash_mismatch"
  // the daily Merkle root
  | "merkle_invalid"
  | "merkle_receipt_unknown"
  | "merkle_root_mismatch"
  | "merkle_inclusion_failed";

/** Where the check stopped: 1-based segment, event number, receipt field or reason. */
export type ChainBreak = {
  segment: number | null;
  sequence: number | null;
  /** The refusal of verifySignedEvidenceReceiptV2, or the receipt field that does not match. */
  detail: string | null;
};

export type ChainSummary = {
  segments: number;
  headSegmentHash: string | null;
  receipts: number;
  receiptKeyIds: string[];
  transactionFormat: string | null;
  finalDocumentSha256: string;
  merkle: { receiptId: string; index: number; treeSize: number; root: string } | null;
};

export type ChainOutcome = {
  exitCode: 0 | 1;
  /** What the CLI prints: one line, or one JSON object with --json. */
  line: string;
  problem: ChainProblem | null;
  at: ChainBreak | null;
  summary: ChainSummary | null;
};

export type ChainIo = { readFile: ReadFile; join: JoinPath };

type Manifest = {
  segments: string[];
  receipts: string[];
  head: EvidenceChainHeadV2 | null;
  initialDocument: string | null;
  merkle: string | null;
};

type MerkleFile = {
  receiptId: string;
  index: number;
  treeSize: number;
  root: string;
  proof: string[];
  leaves: string[] | null;
};

const HEX64 = /^[0-9a-f]{64}$/;
// A name in the package directory: never a path, never "." or "..".
const FILE_NAME = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,128}$/;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]) =>
  Object.keys(value).every((key) => keys.includes(key));

const isFileName = (value: unknown): value is string =>
  typeof value === "string" && FILE_NAME.test(value);

const isNames = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every(isFileName);

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}

function readManifest(value: unknown): Manifest | null {
  const keys = ["format", "segments", "receipts", "head", "initialDocument", "merkle"];
  if (!isObject(value) || !hasOnly(value, keys)) return null;
  if (value.format !== CHAIN_MANIFEST_FORMAT) return null;
  const { segments, receipts, head, initialDocument = null, merkle = null } = value;
  if (!isNames(segments, MAX_CHAIN_SEGMENTS) || !isNames(receipts, MAX_CHAIN_SEGMENTS)) {
    return null;
  }
  // The head the server recorded; it is what a dropped last segment breaks.
  const validHead =
    head === null ||
    (isObject(head) &&
      hasOnly(head, ["segmentHash", "segmentCount"]) &&
      typeof head.segmentHash === "string" &&
      HEX64.test(head.segmentHash) &&
      Number.isSafeInteger(head.segmentCount));
  if (!validHead) return null;
  if (initialDocument !== null && !isFileName(initialDocument)) return null;
  if (merkle !== null && !isFileName(merkle)) return null;
  return {
    segments,
    receipts,
    head: head as EvidenceChainHeadV2 | null,
    initialDocument,
    merkle,
  };
}

function readMerkle(value: unknown): MerkleFile | null {
  const keys = ["receiptId", "index", "treeSize", "root", "proof", "leaves"];
  if (!isObject(value) || !hasOnly(value, keys)) return null;
  const { receiptId, index, treeSize, root, proof, leaves = null } = value;
  const hexList = (list: unknown, max: number): list is string[] =>
    Array.isArray(list) &&
    list.length <= max &&
    list.every((item) => typeof item === "string" && HEX64.test(item));
  if (
    typeof receiptId !== "string" ||
    receiptId === "" ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(treeSize) ||
    typeof root !== "string" ||
    !HEX64.test(root) ||
    !hexList(proof, 64) ||
    (leaves !== null && !hexList(leaves, 1_000_000))
  ) {
    return null;
  }
  return {
    receiptId,
    index: index as number,
    treeSize: treeSize as number,
    root,
    proof,
    leaves: leaves as string[] | null,
  };
}

const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");

/** The receipt fields that must repeat the segment they confirm, in this order. */
function receiptSegmentMismatch(
  receipt: SignedEvidenceReceiptV2,
  verified: VerifiedEvidencePayloadV2,
  previous: { hash: string; receiptId: string; packageId: string; domainId: string } | null,
): string | null {
  const payload = receipt.payload;
  const segment = verified.segment;
  const expected: [string, unknown, unknown][] = [
    ["segmentHash", payload.segmentHash, verified.sha256],
    ["predecessorSegmentHash", payload.predecessorSegmentHash, previous?.hash ?? null],
    ["previousReceiptId", payload.previousReceiptId, previous?.receiptId ?? null],
    ["documentId", payload.documentId, segment.documentId],
    ["sessionId", payload.sessionId, segment.sessionId],
    ["segmentId", payload.segmentId, segment.segmentId],
    ["evidenceSchema", payload.evidenceSchema, segment.evidenceSchema],
    ["evidenceProfileId", payload.evidenceProfileId, segment.evidenceProfileId],
    ["sequenceFrom", payload.sequenceFrom, segment.sequenceFrom],
    ["sequenceTo", payload.sequenceTo, segment.sequenceTo],
    ["eventCount", payload.eventCount, segment.events.length],
    ["payloadBytes", payload.payloadBytes, verified.byteLength],
    [
      "evidencePackageId",
      payload.evidencePackageId,
      previous?.packageId ?? payload.evidencePackageId,
    ],
    ["evidenceDomainId", payload.evidenceDomainId, previous?.domainId ?? payload.evidenceDomainId],
  ];
  return expected.find(([, actual, wanted]) => actual !== wanted)?.[0] ?? null;
}

type Replay = {
  revisionZero: string;
  start: (
    initial: JcsJsonValue,
    first: EvidenceSegment,
  ) => ReturnType<typeof findEvidenceStartBreakV2<unknown>>;
  replay: (
    initial: JcsJsonValue,
    segments: readonly EvidenceSegment[],
  ) => Promise<EvidenceReplayResultV2>;
};

function replayOf<T>(replayer: EvidenceStepReplayerV2<T>, revisionZero: string): Replay {
  return {
    revisionZero,
    start: (initial, first) => findEvidenceStartBreakV2(initial, first, replayer),
    replay: (initial, segments) => replayEvidenceSegmentsV2(initial, segments, replayer),
  };
}

/** The server's replayer and revision 0 of one transaction format, or null. */
function replayerFor(format: string): Replay | null {
  if (format === EDIT_STEP_FORMAT_V1)
    return replayOf(createEditStepsV1Replayer(), REVISION_ZERO_JCS);
  if (format === EDIT_STEP_FORMAT_V3) {
    return replayOf(createEditStepsV3Replayer(), REVISION_ZERO_V3_JCS);
  }
  return null;
}

/** The three options, or null; `--json` may stand anywhere. */
export function parseChainArgs(
  argv: readonly string[],
): { directory: string; keys: string; json: boolean } | null {
  const rest = argv.filter((arg) => arg !== "--json");
  const json = rest.length !== argv.length;
  if (argv.length - rest.length > 1 || rest.length !== 4) return null;
  const found = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const [name, value] = [rest[i]!, rest[i + 1]!];
    if (!["--chain", "--public-keys"].includes(name) || found.has(name) || value === "") {
      return null;
    }
    found.set(name, value);
  }
  return { directory: found.get("--chain")!, keys: found.get("--public-keys")!, json };
}

function outcomeLine(json: boolean, outcome: Omit<ChainOutcome, "line">): string {
  // Wrong arguments are a person's mistake: the usage line, also with --json.
  if (outcome.problem === "usage") return CHAIN_USAGE;
  if (json) {
    return JSON.stringify({
      ok: outcome.exitCode === 0,
      problem: outcome.problem,
      at: outcome.at,
      summary: outcome.summary,
    });
  }
  if (outcome.problem !== null) {
    const at = outcome.at;
    const place = [
      at?.segment != null ? `odsjecak ${at.segment}` : null,
      at?.sequence != null ? `dogadaj ${at.sequence}` : null,
      at?.detail != null ? at.detail : null,
    ].filter((part) => part !== null);
    return `NEISPRAVNO: ${outcome.problem}${place.length > 0 ? ` (${place.join(", ")})` : ""}`;
  }
  const s = outcome.summary!;
  const merkle =
    s.merkle === null
      ? "Merkle dokaz nije u paketu"
      : `potvrda ${s.merkle.receiptId} u dnevnom korijenu ${s.merkle.root} (list ${s.merkle.index + 1} od ${s.merkle.treeSize})`;
  return (
    `ISPRAVNO: odsjecaka ${s.segments}, glava ${s.headSegmentHash ?? "-"}, ` +
    `potvrda ${s.receipts} (kljuc ${[...new Set(s.receiptKeyIds)].join(", ") || "-"}), ` +
    `replay ${s.transactionFormat ?? "-"} do dokumenta ${s.finalDocumentSha256}, ${merkle}`
  );
}

/** `--chain <directory> --public-keys <file> [--json]`. */
export async function runChainVerify(argv: readonly string[], io: ChainIo): Promise<ChainOutcome> {
  const args = parseChainArgs(argv);
  const json = args?.json ?? argv.includes("--json");
  const done = (outcome: Omit<ChainOutcome, "line">): ChainOutcome => ({
    ...outcome,
    line: outcomeLine(json, outcome),
  });
  const refuse = (problem: ChainProblem, at: Partial<ChainBreak> | null = null): ChainOutcome =>
    done({
      exitCode: 1,
      problem,
      at:
        at === null
          ? null
          : {
              segment: at.segment ?? null,
              sequence: at.sequence ?? null,
              detail: at.detail ?? null,
            },
      summary: null,
    });
  if (args === null) return refuse("usage");

  const read = async (name: string, max: number) => io.readFile(io.join(args.directory, name), max);

  // 1. The manifest and the trusted keys (a file outside the package).
  const manifestBytes = await read(CHAIN_MANIFEST, MAX_MANIFEST_BYTES);
  const keysBytes = await io.readFile(args.keys, MAX_KEYS_FILE_BYTES);
  if (manifestBytes === null || keysBytes === null) return refuse("file_unreadable");
  if (manifestBytes === "too_large" || keysBytes === "too_large") return refuse("file_too_large");
  const manifest = readManifest(parseJson(manifestBytes));
  if (manifest === null) return refuse("manifest_invalid");
  const keys = parseJson(keysBytes);
  if (!Array.isArray(keys)) return refuse("keys_invalid");

  // 2. The segments as stored bytes, then the chain: JCS, hash, predecessor, head.
  const payloads: Uint8Array[] = [];
  for (const [index, name] of manifest.segments.entries()) {
    const bytes = await read(name, MAX_EVIDENCE_SEGMENT_BYTES);
    if (bytes === null) return refuse("file_unreadable", { segment: index + 1 });
    if (bytes === "too_large") return refuse("too_large", { segment: index + 1 });
    payloads.push(bytes);
  }
  const chain = await verifyEvidenceChainV2(payloads, manifest.head);
  if (!chain.ok) {
    return refuse(chain.reason, { segment: chain.index === null ? null : chain.index + 1 });
  }
  const [firstBreak] = chain.discontinuities;
  if (firstBreak !== undefined) {
    return refuse("record_break", {
      segment: firstBreak.index + 1,
      sequence: firstBreak.sequenceFrom,
    });
  }
  const verified: VerifiedEvidencePayloadV2[] = [];
  for (const payload of payloads) {
    const one = await verifyCanonicalEvidencePayloadV2(payload);
    // Already passed in the chain check; a second answer would be a fault here.
    if (!one.ok) return refuse("invalid_segment", { segment: verified.length + 1 });
    verified.push(one);
  }

  // 3. One signed receipt v2 per segment, under the trusted keys, bound to it.
  if (manifest.receipts.length !== verified.length) return refuse("receipt_count_mismatch");
  const keyIds: string[] = [];
  const digests = new Map<string, string>();
  let previous: { hash: string; receiptId: string; packageId: string; domainId: string } | null =
    null;
  for (const [index, name] of manifest.receipts.entries()) {
    const segment = index + 1;
    const bytes = await read(name, MAX_RECEIPT_FILE_BYTES);
    if (bytes === null) return refuse("file_unreadable", { segment });
    if (bytes === "too_large") return refuse("file_too_large", { segment });
    const receipt = parseJson(bytes);
    if (!isSignedEvidenceReceiptV2(receipt)) return refuse("receipt_malformed", { segment });
    const verification = await verifySignedEvidenceReceiptV2(
      receipt,
      {
        documentId: verified[index]!.segment.documentId,
        // A receipt names its commit; the record holds nothing else to compare them with.
        clientTransactionId: receipt.payload.clientTransactionId,
        revision: receipt.payload.revision,
        evidenceDomainId: previous?.domainId ?? receipt.payload.evidenceDomainId,
      },
      keys as EvidenceDomainKey[],
    );
    if (!verification.ok) {
      return refuse("receipt_refused", { segment, detail: verification.reason });
    }
    const mismatch = receiptSegmentMismatch(receipt, verified[index]!, previous);
    if (mismatch !== null) return refuse("receipt_segment_mismatch", { segment, detail: mismatch });
    keyIds.push(receipt.signature.keyId);
    digests.set(receipt.payload.receiptId, receipt.payloadDigestSha256);
    previous = {
      hash: verified[index]!.sha256,
      receiptId: receipt.payload.receiptId,
      packageId: receipt.payload.evidencePackageId,
      domainId: receipt.payload.evidenceDomainId,
    };
  }

  // 4. Replay from the starting document; the replayer checks every removed range (B-12).
  const segments: EvidenceSegment[] = verified.map((one) => one.segment);
  let transactionFormat: string | null = null;
  let finalDocumentSha256: string;
  {
    const format = segments[0]?.captureContext.transactionFormat ?? EDIT_STEP_FORMAT_V1;
    const chosen = replayerFor(format);
    if (chosen === null) return refuse("unsupported_format", { segment: 1 });
    let initial: JcsJsonValue;
    if (manifest.initialDocument === null) {
      initial = JSON.parse(chosen.revisionZero) as JcsJsonValue;
    } else {
      const bytes = await read(manifest.initialDocument, MAX_DOCUMENT_FILE_BYTES);
      if (bytes === null) return refuse("file_unreadable");
      if (bytes === "too_large") return refuse("file_too_large");
      const parsed = parseJson(bytes);
      if (parsed === undefined) return refuse("invalid_document");
      initial = parsed as JcsJsonValue;
    }
    if (segments.length > 0) {
      transactionFormat = format;
      const start = await chosen.start(initial, segments[0]!);
      if (!start.ok) return refuse("invalid_document");
      if (start.discontinuity !== null) {
        return refuse("record_break", { segment: 1, sequence: segments[0]!.sequenceFrom });
      }
    }
    const replay = await chosen.replay(initial, segments);
    if (!replay.ok) {
      return refuse(replay.reason, {
        segment: replay.segmentIndex === null ? null : replay.segmentIndex + 1,
        sequence: replay.sequence,
      });
    }
    finalDocumentSha256 = replay.documentSha256;
  }

  // 5. The daily Merkle root and the inclusion of one of these receipts in it.
  let merkle: ChainSummary["merkle"] = null;
  if (manifest.merkle !== null) {
    const bytes = await read(manifest.merkle, MAX_MERKLE_FILE_BYTES);
    if (bytes === null) return refuse("file_unreadable");
    if (bytes === "too_large") return refuse("file_too_large");
    const proof = readMerkle(parseJson(bytes));
    if (proof === null) return refuse("merkle_invalid");
    const digest = digests.get(proof.receiptId);
    if (digest === undefined) return refuse("merkle_receipt_unknown");
    const root = fromHex(proof.root);
    if (proof.leaves !== null) {
      // The day's receipt digests in log order: the root must be theirs, the receipt one of them.
      if (proof.leaves.length !== proof.treeSize || proof.leaves[proof.index] !== digest) {
        return refuse("merkle_root_mismatch");
      }
      const leafHashes = await Promise.all(
        proof.leaves.map((leaf) => evidenceLogLeafHash(fromHex(leaf))),
      );
      if (toHex(await evidenceLogRoot(leafHashes)) !== proof.root) {
        return refuse("merkle_root_mismatch");
      }
    }
    const included = await verifyEvidenceLogInclusion({
      leafHash: await evidenceLogLeafHash(fromHex(digest)),
      index: proof.index,
      treeSize: proof.treeSize,
      proof: proof.proof.map(fromHex),
      root,
    });
    if (!included) return refuse("merkle_inclusion_failed");
    merkle = {
      receiptId: proof.receiptId,
      index: proof.index,
      treeSize: proof.treeSize,
      root: proof.root,
    };
  }

  return done({
    exitCode: 0,
    problem: null,
    at: null,
    summary: {
      segments: segments.length,
      headSegmentHash: chain.head?.segmentHash ?? null,
      receipts: keyIds.length,
      receiptKeyIds: keyIds,
      transactionFormat,
      finalDocumentSha256,
      merkle,
    },
  });
}
