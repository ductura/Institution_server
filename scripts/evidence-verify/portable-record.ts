// SRV-1312 (plan M7.10): the offline check of an unpacked portable record of
// a submission, with the same CLI as the daily root (SRV-1311):
//   node scripts/evidence-verify/index.ts --record <directory>
// Reads only the files of that directory, never the network or a database.
// The record's own check is server/downloads/portable-record; the signature
// of its daily root is checked here with the SRV-1311 format, since downloads
// does not import evidence. Exit code 0 when everything holds, 1 otherwise;
// a failure names a closed code, never an input value.
import { verify } from "node:crypto";

import {
  MAX_PORTABLE_RECORD_FILE_BYTES,
  PORTABLE_RECORD_FILES,
  verifyPortableRecord,
  type DailyRootCheck,
  type PortableRecordProblem,
} from "../../server/downloads/portable-record/index.ts";
import {
  dailyRootPublicKey,
  dailyRootSigningInput,
  readDailyRootRecord,
} from "../../server/evidence/daily-root/index.ts";

import type { ReadFile } from "./verify.ts";

export type RecordProblem = PortableRecordProblem | "usage" | "file_unreadable";

export type RecordOutcome = {
  exitCode: 0 | 1;
  /** One line for the person who runs the check. */
  line: string;
  problem: RecordProblem | null;
};

export const RECORD_USAGE = "Upotreba: node scripts/evidence-verify/index.ts --record <mapa>";

/** The names in a directory, or null when it cannot be listed. */
export type ListDirectory = (path: string) => Promise<readonly string[] | null>;

/** Joins a directory and a name the way the CLI reads them. */
export type JoinPath = (directory: string, name: string) => string;

const KNOWN = new Set<string>(Object.values(PORTABLE_RECORD_FILES));
const MAX_UNKNOWN_BYTES = 1;

/** Ed25519 over the SRV-1311 signing input, with the key the record carries. */
export const checkDailyRootSignature: DailyRootCheck = async (recordBytes, keyBytes) => {
  const key = dailyRootPublicKey(Buffer.from(keyBytes).toString("utf8"));
  if (key === null) return { ok: false };
  let record;
  try {
    record = readDailyRootRecord(JSON.parse(Buffer.from(recordBytes).toString("utf8")));
  } catch {
    return { ok: false };
  }
  if (record === null) return { ok: false };
  const signature = Buffer.from(record.signature, "base64url");
  if (signature.byteLength !== 64 || signature.toString("base64url") !== record.signature) {
    return { ok: false };
  }
  try {
    if (!verify(null, dailyRootSigningInput(record), key, signature)) return { ok: false };
  } catch {
    return { ok: false, unavailable: true };
  }
  return { ok: true, day: record.day, root: record.root, count: record.count, keyId: record.keyId };
};

function refuse(problem: RecordProblem): RecordOutcome {
  return {
    exitCode: 1,
    line: problem === "usage" ? RECORD_USAGE : `NEISPRAVNO: ${problem}`,
    problem,
  };
}

/** `--record <directory>`: the check of every file of one unpacked record. */
export async function runPortableRecordVerify(
  argv: readonly string[],
  io: { readFile: ReadFile; listDirectory: ListDirectory; join: JoinPath },
): Promise<RecordOutcome> {
  if (argv.length !== 2 || argv[0] !== "--record" || !argv[1]) return refuse("usage");
  const directory = argv[1];
  const names = await io.listDirectory(directory);
  if (names === null) return refuse("file_unreadable");
  const files = new Map<string, Uint8Array>();
  for (const name of names) {
    // An unknown name is refused by the check; its bytes are never read.
    if (!KNOWN.has(name)) {
      files.set(name, new Uint8Array(MAX_UNKNOWN_BYTES));
      continue;
    }
    const max = MAX_PORTABLE_RECORD_FILE_BYTES[name as keyof typeof MAX_PORTABLE_RECORD_FILE_BYTES];
    const bytes = await io.readFile(io.join(directory, name), max);
    if (bytes === null) return refuse("file_unreadable");
    if (bytes === "too_large") return refuse("file_too_large");
    files.set(name, bytes);
  }
  const verdict = await verifyPortableRecord(files, checkDailyRootSignature);
  if (!verdict.ok) return refuse(verdict.problem);
  const day =
    verdict.dailyRoot === null
      ? "dnevni korijen jos nije zatvoren"
      : `dnevni korijen ${verdict.dailyRoot.day} (kljuc ${verdict.dailyRoot.keyId})`;
  return {
    exitCode: 0,
    line: `ISPRAVNO: predaja ${verdict.submissionId}, kljuc potvrde ${verdict.receiptKeyId}, ${day}`,
    problem: null,
  };
}
