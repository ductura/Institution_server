// DAN-1563: checks one evidence package from files alone, with no database
// and no network, with the same CLI as the daily root (SRV-1311):
//   node scripts/evidence-verify/index.ts --package <package.json> --trust <trust.json> [--json]
// Every check is a call of server/domain/forensics; nothing here hashes,
// canonicalizes or verifies a signature itself.
import {
  type EvidenceDomainKey,
  evidenceLogLeafHash,
  isEvidenceDomainId,
  isPlainObject,
  isSignedEvidenceReceiptV2,
  type SignedEvidenceReceiptV2,
  verifyCanonicalEvidencePayloadV2,
  verifyEvidenceChainV2,
  verifyEvidenceLogInclusion,
  verifySignedEvidenceReceiptV2,
} from "../../server/domain/index.ts";

export const EVIDENCE_VERIFY_PACKAGE_SCHEMA = "ductura-evidence-verify-package-v1" as const;

/** What the party under check hands over: the record and its receipts. */
export type EvidenceVerifyPackage = {
  packageSchema: typeof EVIDENCE_VERIFY_PACKAGE_SCHEMA;
  /** Canonical JCS text of every segment, in chain order. */
  segments: string[];
  /** One signed receipt v2 per segment, in the same order. */
  receipts: unknown[];
  /** Where each receipt sits in the receipt log; needed only with `trust.log`. */
  inclusions?: { index: number; proofHex: string[] }[];
};

/** What the verifying party brings itself and never reads from the package. */
export type EvidenceVerifyTrust = {
  evidenceDomainId: string;
  keys: EvidenceDomainKey[];
  /** Published root of the receipt log and its size, if one is known. */
  log?: { treeSize: number; rootHex: string };
};

export type EvidenceCheckName = "package" | "chain" | "receipts" | "log" | "replay";

export type EvidenceCheck = {
  check: EvidenceCheckName;
  status: "ok" | "failed" | "skipped";
  /** Machine-readable cause; absent for `ok`. */
  reason?: string;
  /** Zero-based index of the segment (and receipt) at which the check stopped. */
  index?: number;
};

export type EvidenceVerifyReport = { ok: boolean; checks: EvidenceCheck[] };

const HASH_HEX = /^[0-9a-f]{64}$/u;
const fromHex = (hex: string) => new Uint8Array(Buffer.from(hex, "hex"));
const failed = (check: EvidenceCheckName, reason: string, index?: number): EvidenceCheck =>
  index === undefined
    ? { check, status: "failed", reason }
    : { check, status: "failed", reason, index };

function isPackage(value: unknown): value is EvidenceVerifyPackage {
  return (
    isPlainObject(value) &&
    value.packageSchema === EVIDENCE_VERIFY_PACKAGE_SCHEMA &&
    Array.isArray(value.segments) &&
    value.segments.length > 0 &&
    value.segments.every((segment) => typeof segment === "string") &&
    Array.isArray(value.receipts) &&
    value.receipts.length === value.segments.length &&
    (value.inclusions === undefined ||
      (Array.isArray(value.inclusions) &&
        value.inclusions.length === value.segments.length &&
        value.inclusions.every(
          (entry) =>
            isPlainObject(entry) &&
            Number.isSafeInteger(entry.index) &&
            Array.isArray(entry.proofHex) &&
            entry.proofHex.every((hash) => typeof hash === "string" && HASH_HEX.test(hash)),
        )))
  );
}

function isTrust(value: unknown): value is EvidenceVerifyTrust {
  return (
    isPlainObject(value) &&
    isEvidenceDomainId(value.evidenceDomainId) &&
    Array.isArray(value.keys) &&
    (value.log === undefined ||
      (isPlainObject(value.log) &&
        Number.isSafeInteger(value.log.treeSize) &&
        typeof value.log.rootHex === "string" &&
        HASH_HEX.test(value.log.rootHex)))
  );
}

/**
 * The receipt of segment `index`: signed by a trusted receipt key of the
 * expected domain, and a receipt of exactly these segment bytes.
 */
async function checkReceipt(
  receipt: unknown,
  segmentText: string,
  trust: EvidenceVerifyTrust,
): Promise<{ ok: true; receipt: SignedEvidenceReceiptV2 } | { ok: false; reason: string }> {
  const stored = await verifyCanonicalEvidencePayloadV2(segmentText);
  if (!stored.ok || !isSignedEvidenceReceiptV2(receipt)) {
    return { ok: false, reason: "receipt_malformed" };
  }
  // The commit (transaction and revision) is known only from the receipt; the
  // document comes from the segment and the domain from the verifying party.
  const verified = await verifySignedEvidenceReceiptV2(
    receipt,
    {
      documentId: stored.segment.documentId,
      clientTransactionId: receipt.payload.clientTransactionId,
      revision: receipt.payload.revision,
      evidenceDomainId: trust.evidenceDomainId,
    },
    trust.keys,
  );
  if (!verified.ok) return { ok: false, reason: verified.reason };
  const { payload } = verified;
  const sameSegment =
    payload.segmentHash === stored.sha256 &&
    payload.segmentId === stored.segment.segmentId &&
    payload.predecessorSegmentHash === stored.segment.predecessorSegmentHash &&
    payload.sequenceFrom === stored.segment.sequenceFrom &&
    payload.eventCount === stored.segment.events.length &&
    payload.payloadBytes === stored.byteLength;
  return sameSegment ? { ok: true, receipt } : { ok: false, reason: "segment_mismatch" };
}

/**
 * Runs every check and never stops at the first failed one, so the report
 * names each break. `ok` is true only when no check failed; a skipped check
 * is listed as skipped and proves nothing.
 */
export async function verifyEvidencePackage(
  evidencePackage: unknown,
  trust: unknown,
): Promise<EvidenceVerifyReport> {
  if (!isTrust(trust)) return { ok: false, checks: [failed("package", "trust_malformed")] };
  if (!isPackage(evidencePackage)) {
    return { ok: false, checks: [failed("package", "package_malformed")] };
  }
  const { segments, receipts, inclusions } = evidencePackage;
  const checks: EvidenceCheck[] = [{ check: "package", status: "ok" }];

  let receiptCheck: EvidenceCheck = { check: "receipts", status: "ok" };
  const signed: SignedEvidenceReceiptV2[] = [];
  for (let index = 0; index < segments.length && receiptCheck.status === "ok"; index++) {
    const result = await checkReceipt(receipts[index], segments[index]!, trust);
    if (result.ok) signed.push(result.receipt);
    else receiptCheck = failed("receipts", result.reason, index);
  }

  // The head is the one the last signed receipt commits to; without a valid
  // last receipt there is no head to compare the chain with.
  const last = signed.length === segments.length ? signed.at(-1) : undefined;
  if (last === undefined) {
    checks.push(failed("chain", "head_unknown"));
  } else {
    const chain = await verifyEvidenceChainV2(segments, {
      segmentHash: last.payload.segmentHash,
      segmentCount: segments.length,
    });
    const gap = chain.ok ? chain.discontinuities[0] : undefined;
    if (!chain.ok) checks.push(failed("chain", chain.reason, chain.index ?? undefined));
    else if (gap !== undefined) {
      checks.push(
        failed("chain", gap.documentHashBreak ? "document_hash_break" : gap.sequence, gap.index),
      );
    } else checks.push({ check: "chain", status: "ok" });
  }
  checks.push(receiptCheck);

  if (trust.log === undefined) {
    checks.push({ check: "log", status: "skipped", reason: "no_log_root" });
  } else if (inclusions === undefined || last === undefined) {
    checks.push(failed("log", "no_inclusion_proofs"));
  } else {
    let logCheck: EvidenceCheck = { check: "log", status: "ok" };
    for (let index = 0; index < signed.length && logCheck.status === "ok"; index++) {
      const included = await verifyEvidenceLogInclusion({
        leafHash: await evidenceLogLeafHash(fromHex(signed[index]!.payloadDigestSha256)),
        index: inclusions[index]!.index,
        treeSize: trust.log.treeSize,
        proof: inclusions[index]!.proofHex.map(fromHex),
        root: fromHex(trust.log.rootHex),
      });
      if (!included) logCheck = failed("log", "not_in_log", index);
    }
    checks.push(logCheck);
  }

  // Package v1 carries neither the starting document nor the replayer of its
  // transaction format, so the steps are not replayed here; replay stays with
  // the server's reconstruction (server/evidence/reconstruction).
  checks.push({ check: "replay", status: "skipped", reason: "replay_not_in_package" });
  return { ok: checks.every((check) => check.status !== "failed"), checks };
}
