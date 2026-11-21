// CLI entry of the offline check of a signed daily root (SRV-1311):
//   node scripts/evidence-verify/index.ts --root root.json --entries entries.ndjson --public-key key.pem
// Exit code 0 when the record verifies, 1 otherwise. No network, no database.
import { open } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { runEvidenceVerify, type ReadFile } from "./verify.ts";

export { runEvidenceVerify, parseArgs, parseEntries, USAGE, type VerifyOutcome } from "./verify.ts";

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

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outcome = await runEvidenceVerify(process.argv.slice(2), readLocalFile);
  (outcome.exitCode === 0 ? process.stdout : process.stderr).write(`${outcome.line}\n`);
  process.exitCode = outcome.exitCode;
}
