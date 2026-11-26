// CLI entry of the offline check of a signed daily root (SRV-1311):
//   node scripts/evidence-verify/index.ts --root root.json --entries entries.ndjson --public-key key.pem
// Exit code 0 when the record verifies, 1 otherwise. No network, no database.
// SRV-1312: the unpacked portable record of a submission, with the same CLI:
//   node scripts/evidence-verify/index.ts --record <directory>
// DAN-1563: one evidence package (segment chain, signed receipts v2, receipt
// log) against a trust file the verifying party brings, exit 0, 1 or 2:
//   node scripts/evidence-verify/index.ts --package <package.json> --trust <trust.json> [--json]
import { open, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { runPackageVerify } from "./package-cli.ts";
import { runPortableRecordVerify, type ListDirectory } from "./portable-record.ts";
import { runEvidenceVerify, type ReadFile } from "./verify.ts";

export { runEvidenceVerify, parseArgs, parseEntries, USAGE, type VerifyOutcome } from "./verify.ts";
export {
  checkDailyRootSignature,
  RECORD_USAGE,
  runPortableRecordVerify,
  type RecordOutcome,
} from "./portable-record.ts";
export {
  EVIDENCE_VERIFY_PACKAGE_SCHEMA,
  verifyEvidencePackage,
  type EvidenceCheck,
  type EvidenceCheckName,
  type EvidenceVerifyPackage,
  type EvidenceVerifyReport,
  type EvidenceVerifyTrust,
} from "./package.ts";
export {
  formatReport,
  PACKAGE_USAGE,
  parsePackageArgs,
  runPackageVerify,
  type PackageOutcome,
} from "./package-cli.ts";

/** Reads at most `maxBytes`; a longer file is "too_large", a missing one null. */
export const readLocalFile: ReadFile = async (path, maxBytes) => {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const { size } = await handle.stat();
    if (size > maxBytes) return "too_large";
    const buffer = new Uint8Array(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead);
  } catch {
    return null;
  } finally {
    await handle.close();
  }
};

/** The names of the regular files in a directory, or null. */
export const listLocalDirectory: ListDirectory = async (path) => {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    return entries.map((entry) => entry.name);
  } catch {
    return null;
  }
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  if (argv.includes("--package") || argv.includes("--trust")) {
    const { exitCode, output } = await runPackageVerify(argv, readLocalFile);
    (exitCode === 2 ? process.stderr : process.stdout).write(output);
    process.exitCode = exitCode;
  } else {
    const outcome =
      argv[0] === "--record"
        ? await runPortableRecordVerify(argv, {
            readFile: readLocalFile,
            listDirectory: listLocalDirectory,
            join,
          })
        : await runEvidenceVerify(argv, readLocalFile);
    (outcome.exitCode === 0 ? process.stdout : process.stderr).write(`${outcome.line}\n`);
    process.exitCode = outcome.exitCode;
  }
}
