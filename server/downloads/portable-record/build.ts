// SRV-1312: the ZIP of a portable record. Everything that goes in is checked
// first, with the same functions the offline check uses: the stored receipt
// must be its own JCS, hash to its stored digest and verify with the key the
// database names; the text must hash to the receipt's artifactSha256; a daily
// root's entries must give its root and hold the receipt's entry. Only then
// are the files written: stored entries, a fixed time and a fixed order, so
// the same submission gives the same bytes.
import {
  canonicalizeJcs,
  digestSubmissionReceiptPayloadV2,
  evidenceLogInclusionProof,
  evidenceLogLeafHash,
  evidenceLogRoot,
  isSignedSubmissionReceiptV2,
  isSubmissionReceiptPayloadV2,
  orderEvidenceLogEntries,
  verifyEvidenceLogInclusion,
  verifySignedSubmissionReceiptV2,
  type SignedSubmissionReceiptV2,
} from "../../domain/index.ts";
import { writeZip } from "../export/index.ts";
import { renderReceiptPdf, type ReceiptPdfLabels } from "../receipt-pdf/index.ts";

import {
  bytesHex,
  hexBytes,
  logEntryDay,
  PORTABLE_RECORD_FILES as FILES,
  PORTABLE_RECORD_FORMAT,
  sha256Hex,
  submissionLogEntry,
  type PortableDailyRoot,
  type PortableDailyRootSource,
  type PortableLogEntry,
  type PortableRecordFileName,
  type PortableRecordManifest,
} from "./format.ts";

/** What the database gave for one submission of the caller. */
export type PortableRecordSource = {
  /** The stored receipt payload text (its own JCS). */
  readonly receiptPayload: string;
  readonly payloadDigestSha256: string;
  readonly signature: unknown;
  /** The receipt key as an EvidenceDomainKey (algorithm, ids, SPKI, domain, validity). */
  readonly key: unknown;
  /** The exact stored text of the submitted revision. */
  readonly text: string;
};

export type PortableRecordRefusal =
  | "receipt_malformed"
  | "receipt_unverified"
  | "text_mismatch"
  | "daily_root_unavailable"
  | "daily_root_mismatch"
  | "verification_unavailable";

export type PortableRecordBuild =
  | {
      readonly status: "built";
      readonly bytes: Uint8Array;
      /** Lowercase hex SHA-256 of `bytes`. */
      readonly sha256: string;
      /** The names in the ZIP, in order. */
      readonly names: readonly string[];
      /** The receipt PDF inside the ZIP (same bytes), for the confirmation for the registrar (SRV-1807). */
      readonly receiptPdf: Uint8Array;
    }
  /** A closed code for the server's own record; never shown with any value of it. */
  | { readonly status: "refused"; readonly reason: PortableRecordRefusal };

export type PortableRecordInput = {
  readonly submissionId: string;
  readonly source: PortableRecordSource;
  readonly dailyRoot: PortableDailyRootSource;
  /** The configured origin of the institution, for the QR of the PDF. */
  readonly origin: string;
  readonly labels: ReceiptPdfLabels;
};

const KEY_FIELDS = [
  "algorithm",
  "keyId",
  "keyVersion",
  "encoding",
  "keyBase64Url",
  "evidenceDomainId",
  "purpose",
  "validFrom",
  "validTo",
  "revokedAt",
] as const;

const encoder = new TextEncoder();
const refuse = (reason: PortableRecordRefusal): PortableRecordBuild => ({
  status: "refused",
  reason,
});

/** The receipt as stored, or null when any part of it does not check. */
async function storedReceipt(
  source: PortableRecordSource,
  submissionId: string,
): Promise<SignedSubmissionReceiptV2 | null> {
  try {
    const payload: unknown = JSON.parse(source.receiptPayload);
    if (!isSubmissionReceiptPayloadV2(payload) || payload.submissionId !== submissionId)
      return null;
    const digest = await digestSubmissionReceiptPayloadV2(payload);
    if (digest.canonical !== source.receiptPayload || digest.sha256 !== source.payloadDigestSha256)
      return null;
    const receipt = { payload, payloadDigestSha256: digest.sha256, signature: source.signature };
    return isSignedSubmissionReceiptV2(receipt) ? structuredClone(receipt) : null;
  } catch {
    return null;
  }
}

/** The key reduced to its own fields, or null for anything but a plain record. */
function keyFields(key: unknown): Record<string, unknown> | null {
  if (typeof key !== "object" || key === null || Array.isArray(key)) return null;
  const record = key as Record<string, unknown>;
  return Object.fromEntries(KEY_FIELDS.map((field) => [field, record[field]]));
}

/** The receipt's own fields as the expectation: the check is that it verifies, not what it says. */
export function selfExpectation(receipt: SignedSubmissionReceiptV2): Record<string, unknown> {
  const { receiptSchema: unusedSchema, signedAt: unusedSignedAt, ...expected } = receipt.payload;
  void unusedSchema;
  void unusedSignedAt;
  return expected;
}

type Proof = { index: number; treeSize: number; proof: string[] };

/** The inclusion proof of `entry` in the day's tree, or null when the day does not hold it. */
async function inclusionOf(entry: PortableLogEntry, day: PortableDailyRoot): Promise<Proof | null> {
  if (day.day !== logEntryDay(entry) || day.count !== day.entries.length) return null;
  let ordered: PortableLogEntry[];
  try {
    ordered = orderEvidenceLogEntries(day.entries.map((e) => ({ ...e })));
  } catch {
    return null;
  }
  const index = ordered.findIndex(
    (e) =>
      e.receiptId === entry.receiptId &&
      e.acceptedAt === entry.acceptedAt &&
      e.digest === entry.digest,
  );
  if (index < 0 || ordered.some((e) => !/^[0-9a-f]{64}$/.test(e.digest))) return null;
  const leaves = await Promise.all(ordered.map((e) => evidenceLogLeafHash(hexBytes(e.digest))));
  const root = await evidenceLogRoot(leaves);
  if (bytesHex(root) !== day.root) return null;
  const path = await evidenceLogInclusionProof(leaves, index);
  const leafHash = leaves[index]!;
  const sound = await verifyEvidenceLogInclusion({
    leafHash,
    index,
    treeSize: leaves.length,
    proof: path,
    root,
  });
  return sound ? { index, treeSize: leaves.length, proof: path.map(bytesHex) } : null;
}

/** The ZIP of the portable record of one submission, or a closed refusal. */
export async function buildPortableRecord(
  input: PortableRecordInput,
): Promise<PortableRecordBuild> {
  const receipt = await storedReceipt(input.source, input.submissionId);
  if (receipt === null) return refuse("receipt_malformed");
  const key = keyFields(input.source.key);
  if (key === null) return refuse("receipt_malformed");
  const verdict = await verifySignedSubmissionReceiptV2(receipt, selfExpectation(receipt), [key]);
  if (!verdict.ok) {
    return refuse(
      verdict.reason === "verification_unavailable"
        ? "verification_unavailable"
        : "receipt_unverified",
    );
  }
  const text = encoder.encode(input.source.text);
  if (sha256Hex(text) !== receipt.payload.artifactSha256) return refuse("text_mismatch");

  const entry = submissionLogEntry(receipt);
  const day = await input.dailyRoot(entry);
  if (day.status === "unavailable") return refuse("daily_root_unavailable");

  const files = new Map<PortableRecordFileName, Uint8Array>([
    [FILES.receipt, encoder.encode(canonicalizeJcs(receipt))],
    [FILES.receiptKey, encoder.encode(canonicalizeJcs(key))],
    [FILES.text, text],
    [FILES.pdf, await renderReceiptPdf(receipt, input.origin, input.labels)],
  ]);
  if (day.status === "included") {
    const proof = await inclusionOf(entry, day.dailyRoot);
    if (proof === null) return refuse("daily_root_mismatch");
    files.set(FILES.dailyRoot, Uint8Array.from(day.dailyRoot.record));
    files.set(FILES.dailyRootKey, encoder.encode(day.dailyRoot.publicKeyPem));
    files.set(FILES.proof, encoder.encode(canonicalizeJcs({ entry, ...proof })));
  }

  const names = [...files.keys()].sort();
  const manifest: PortableRecordManifest = {
    format: PORTABLE_RECORD_FORMAT,
    submissionId: input.submissionId,
    dailyRoot: day.status,
    files: names.map((name) => {
      const bytes = files.get(name)!;
      return { name, sha256: sha256Hex(bytes), bytes: bytes.byteLength };
    }),
  };
  const entries = [
    { name: FILES.manifest, data: encoder.encode(canonicalizeJcs(manifest)) },
    ...names.map((name) => ({ name, data: files.get(name)! })),
  ];
  const bytes = writeZip(entries);
  return {
    status: "built",
    bytes,
    sha256: sha256Hex(bytes),
    names: entries.map((e) => e.name),
    receiptPdf: files.get(FILES.pdf)!,
  };
}
