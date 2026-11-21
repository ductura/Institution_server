// SRV-1312: the offline check of an unpacked portable record, with no network
// and no database. The manifest names every file and its SHA-256; the receipt
// must verify with the key the record carries; the text must hash to the
// receipt's artifactSha256, so one changed byte of the text fails; with a
// daily root, the signed root (checked by the caller's DailyRootCheck, the
// SRV-1311 format) must hold the receipt's own entry by the Merkle proof.
// The answer is a closed code; no value of the record is ever echoed.
import {
  canonicalizeJcs,
  evidenceLogLeafHash,
  hasOnlyKeys,
  isPlainObject,
  isSignedSubmissionReceiptV2,
  verifyEvidenceLogInclusion,
  verifySignedSubmissionReceiptV2,
  type SignedSubmissionReceiptV2,
} from "../../domain/index.ts";

import { selfExpectation } from "./build.ts";
import {
  DAILY_ROOT_FILES,
  hexBytes,
  logEntryDay,
  MAX_PORTABLE_RECORD_FILE_BYTES,
  PORTABLE_RECORD_FILES as FILES,
  PORTABLE_RECORD_FORMAT,
  sha256Hex,
  submissionLogEntry,
  type PortableRecordFileName,
} from "./format.ts";

export type PortableRecordProblem =
  | "manifest_malformed"
  | "file_missing"
  | "file_unexpected"
  | "file_too_large"
  | "file_mismatch"
  | "receipt_malformed"
  | "receipt_invalid"
  | "text_mismatch"
  | "daily_root_invalid"
  | "proof_invalid"
  | "verification_unavailable";

/** The SRV-1311 check of a stored daily root record's signature with its PEM key. */
export type DailyRootCheck = (
  record: Uint8Array,
  publicKeyPem: Uint8Array,
) => Promise<
  | { ok: true; day: string; root: string; count: number; keyId: string }
  | { ok: false; unavailable?: boolean }
>;

export type PortableRecordVerification =
  | {
      ok: true;
      submissionId: string;
      signedAt: string;
      receiptKeyId: string;
      /** Null while the record says the day's root was pending. */
      dailyRoot: { day: string; keyId: string } | null;
    }
  | { ok: false; problem: PortableRecordProblem };

const KNOWN = new Set<string>(Object.values(FILES));
const MANIFEST_KEYS = new Set(["format", "submissionId", "dailyRoot", "files"]);
const LINE_KEYS = new Set(["name", "sha256", "bytes"]);
const PROOF_KEYS = new Set(["entry", "index", "treeSize", "proof"]);
const ENTRY_KEYS = new Set(["receiptId", "acceptedAt", "digest"]);
const HEX64 = /^[0-9a-f]{64}$/;

const fail = (problem: PortableRecordProblem): PortableRecordVerification => ({
  ok: false,
  problem,
});

/** JSON whose bytes are exactly the UTF-8 of its own JCS, or undefined. */
function canonicalJson(bytes: Uint8Array): unknown {
  try {
    const value: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
    // Comparing bytes, not text, also refuses bytes that are not valid UTF-8.
    return Buffer.from(canonicalizeJcs(value), "utf8").equals(Buffer.from(bytes))
      ? value
      : undefined;
  } catch {
    return undefined;
  }
}

type Manifest = { submissionId: string; dailyRoot: "included" | "pending"; names: string[] };

function readManifest(value: unknown): Manifest | null {
  if (!isPlainObject(value) || !hasOnlyKeys(value, MANIFEST_KEYS)) return null;
  const { format, submissionId, dailyRoot, files } = value;
  if (format !== PORTABLE_RECORD_FORMAT || typeof submissionId !== "string") return null;
  if ((dailyRoot !== "included" && dailyRoot !== "pending") || !Array.isArray(files)) return null;
  const names: string[] = [];
  for (const line of files as unknown[]) {
    if (!isPlainObject(line) || !hasOnlyKeys(line, LINE_KEYS) || Object.keys(line).length !== 3)
      return null;
    const { name, sha256, bytes } = line;
    if (typeof name !== "string" || !KNOWN.has(name) || name === FILES.manifest) return null;
    if (typeof sha256 !== "string" || !HEX64.test(sha256) || !Number.isSafeInteger(bytes))
      return null;
    if (names.length > 0 && names[names.length - 1]! >= name) return null;
    names.push(name);
  }
  const optional = DAILY_ROOT_FILES.filter((name) => names.includes(name)).length;
  if (optional !== (dailyRoot === "included" ? DAILY_ROOT_FILES.length : 0)) return null;
  const required = [FILES.receipt, FILES.receiptKey, FILES.text, FILES.pdf];
  if (!required.every((name) => names.includes(name))) return null;
  return { submissionId, dailyRoot, names };
}

/** Every listed file has its listed size and SHA-256; nothing unlisted is there. */
function filesMatch(
  files: ReadonlyMap<string, Uint8Array>,
  manifest: Manifest,
  lines: readonly { name: string; sha256: string; bytes: number }[],
): PortableRecordProblem | null {
  for (const name of files.keys()) {
    if (name !== FILES.manifest && !manifest.names.includes(name)) return "file_unexpected";
  }
  for (const line of lines) {
    const bytes = files.get(line.name);
    if (bytes === undefined) return "file_missing";
    if (bytes.byteLength !== line.bytes || sha256Hex(bytes) !== line.sha256) return "file_mismatch";
  }
  return null;
}

async function proofHolds(
  value: unknown,
  receipt: SignedSubmissionReceiptV2,
  root: { day: string; root: string; count: number },
): Promise<boolean> {
  if (!isPlainObject(value) || !hasOnlyKeys(value, PROOF_KEYS)) return false;
  const { entry, index, treeSize, proof } = value;
  if (!isPlainObject(entry) || !hasOnlyKeys(entry, ENTRY_KEYS)) return false;
  const own = submissionLogEntry(receipt);
  if (
    entry.receiptId !== own.receiptId ||
    entry.acceptedAt !== own.acceptedAt ||
    entry.digest !== own.digest ||
    logEntryDay(own) !== root.day ||
    treeSize !== root.count ||
    typeof index !== "number" ||
    !Array.isArray(proof) ||
    !proof.every((hash) => typeof hash === "string" && HEX64.test(hash)) ||
    !HEX64.test(root.root)
  ) {
    return false;
  }
  // The size comes from the signed root and the leaf from the receipt's own digest.
  return verifyEvidenceLogInclusion({
    leafHash: await evidenceLogLeafHash(hexBytes(own.digest)),
    index,
    treeSize: root.count,
    proof: (proof as string[]).map(hexBytes),
    root: hexBytes(root.root),
  });
}

/** The check of the files of one unpacked record, by name. */
export async function verifyPortableRecord(
  files: ReadonlyMap<string, Uint8Array>,
  checkDailyRoot: DailyRootCheck,
): Promise<PortableRecordVerification> {
  try {
    for (const [name, bytes] of files) {
      const max = MAX_PORTABLE_RECORD_FILE_BYTES[name as PortableRecordFileName];
      if (max !== undefined && bytes.byteLength > max) return fail("file_too_large");
    }
    const manifestBytes = files.get(FILES.manifest);
    if (manifestBytes === undefined) return fail("file_missing");
    const manifestValue = canonicalJson(manifestBytes);
    const manifest = readManifest(manifestValue);
    if (manifest === null) return fail("manifest_malformed");
    const lines = (manifestValue as { files: { name: string; sha256: string; bytes: number }[] })
      .files;
    const mismatch = filesMatch(files, manifest, lines);
    if (mismatch !== null) return fail(mismatch);

    const receipt = canonicalJson(files.get(FILES.receipt)!);
    const key = canonicalJson(files.get(FILES.receiptKey)!);
    if (!isSignedSubmissionReceiptV2(receipt) || !isPlainObject(key)) {
      return fail("receipt_malformed");
    }
    if (receipt.payload.submissionId !== manifest.submissionId) return fail("receipt_malformed");
    const verdict = await verifySignedSubmissionReceiptV2(receipt, selfExpectation(receipt), [key]);
    if (!verdict.ok) {
      return fail(
        verdict.reason === "verification_unavailable"
          ? "verification_unavailable"
          : "receipt_invalid",
      );
    }
    if (sha256Hex(files.get(FILES.text)!) !== receipt.payload.artifactSha256) {
      return fail("text_mismatch");
    }

    let dailyRoot: { day: string; keyId: string } | null = null;
    if (manifest.dailyRoot === "included") {
      const root = await checkDailyRoot(
        files.get(FILES.dailyRoot)!,
        files.get(FILES.dailyRootKey)!,
      );
      if (!root.ok)
        return fail(root.unavailable ? "verification_unavailable" : "daily_root_invalid");
      const proof = canonicalJson(files.get(FILES.proof)!);
      if (!(await proofHolds(proof, receipt, root))) return fail("proof_invalid");
      dailyRoot = { day: root.day, keyId: root.keyId };
    }
    return {
      ok: true,
      submissionId: receipt.payload.submissionId,
      signedAt: receipt.payload.signedAt,
      receiptKeyId: receipt.signature.keyId,
      dailyRoot,
    };
  } catch {
    return fail("verification_unavailable");
  }
}
