// SRV-1311 (plan M3.9, B5): the offline check of a signed daily root of the
// evidence log. Reads three files and nothing else: the stored record
// { day, root, count, keyId, signature } (root.json), the entries of that day,
// one JSON object { receiptId, acceptedAt, digest } per line (entries.ndjson),
// and the Ed25519 public key as PEM (key.pem). No network, no database. The
// answer is exit code 0 (the record is signed by the key and commits to
// exactly these entries) or 1 (anything else); a failure names a closed code,
// never an input value.
import {
  dailyRootPublicKey,
  verifyDailyRoot,
  type DailyRootProblem,
} from "../../server/evidence/daily-root/index.ts";

export const USAGE =
  "Upotreba: node scripts/evidence-verify/index.ts --root root.json --entries entries.ndjson --public-key key.pem";

/** Upper bounds of the files, asked before they are parsed. */
export const MAX_ROOT_FILE_BYTES = 4096;
export const MAX_KEY_FILE_BYTES = 4096;
export const MAX_ENTRIES_FILE_BYTES = 512 * 1024 * 1024;

const OPTIONS = ["--root", "--entries", "--public-key"] as const;
type Option = (typeof OPTIONS)[number];

export type VerifyProblem = DailyRootProblem | "usage" | "file_unreadable" | "file_too_large";

export type VerifyOutcome = {
  exitCode: 0 | 1;
  /** One line for the person who runs the check. */
  line: string;
  problem: VerifyProblem | null;
};

/** Reads one file; the CLI passes node:fs, tests a map. Returns null when it cannot. */
export type ReadFile = (path: string, maxBytes: number) => Promise<Uint8Array | "too_large" | null>;

/** The three paths, each given exactly once, or null. */
export function parseArgs(argv: readonly string[]): Record<Option, string> | null {
  const found = new Map<Option, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i] as Option;
    const value = argv[i + 1];
    if (!OPTIONS.includes(name) || found.has(name) || value === undefined || value === "") {
      return null;
    }
    found.set(name, value);
  }
  if (found.size !== OPTIONS.length) return null;
  return Object.fromEntries(found) as Record<Option, string>;
}

/** The entries of an NDJSON text: one object per non-empty line, or null. */
export function parseEntries(text: string): unknown[] | null {
  const entries: unknown[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (trimmed.trim() === "") continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return entries;
}

function decode(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function refuse(problem: VerifyProblem): VerifyOutcome {
  const line = problem === "usage" ? USAGE : `NEISPRAVNO: ${problem}`;
  return { exitCode: 1, line, problem };
}

export async function runEvidenceVerify(
  argv: readonly string[],
  readFile: ReadFile,
): Promise<VerifyOutcome> {
  const args = parseArgs(argv);
  if (args === null) return refuse("usage");

  const files = await Promise.all([
    readFile(args["--root"], MAX_ROOT_FILE_BYTES),
    readFile(args["--entries"], MAX_ENTRIES_FILE_BYTES),
    readFile(args["--public-key"], MAX_KEY_FILE_BYTES),
  ]);
  if (files.includes(null)) return refuse("file_unreadable");
  if (files.includes("too_large")) return refuse("file_too_large");
  const [rootBytes, entriesBytes, keyBytes] = files as [Uint8Array, Uint8Array, Uint8Array];

  const keyText = decode(keyBytes);
  const key = keyText === null ? null : dailyRootPublicKey(keyText);
  if (key === null) return refuse("key_invalid");

  const entriesText = decode(entriesBytes);
  const entries = entriesText === null ? null : parseEntries(entriesText);
  if (entries === null) return refuse("entries_malformed");

  // The record goes in as its bytes: whitespace around the JSON is allowed,
  // as a person may have saved it by hand; the signature covers its fields.
  const verification = await verifyDailyRoot(rootBytes, entries, key);
  if (!verification.ok) return refuse(verification.problem);
  const record = JSON.parse(decode(rootBytes)!) as { day: string; count: number };
  return {
    exitCode: 0,
    line: `ISPRAVNO: dan ${record.day}, unosa ${record.count}`,
    problem: null,
  };
}
