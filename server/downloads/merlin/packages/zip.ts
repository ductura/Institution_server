// The ZIP of the Merlin package (SRV-1110, Val 11, N-18, C-16): the roster
// CSV of SRV-1109, the PDF and DOCX of every submitted work under the names
// the roster gives them, and otisci.sha256 with the SHA-256 of every one of
// those files. All from one set of bytes: the fingerprints in the CSV are
// checked against the files the ZIP carries before it is written, so the CSV,
// otisci.sha256 and the files never disagree. The ZIP writer is the export's
// (stored entries, fixed time), so the same roster gives the same bytes.
import { writeZip, type ZipEntry } from "../../export/index.ts";
import { sha256Hex } from "../files/index.ts";
import { merlinRosterCsv, type MerlinLabels, type MerlinRoster } from "../roster/index.ts";

/** The name of the roster in the ZIP, as teacher.merlin-roster-csv.get names it. */
export const MERLIN_PACKAGE_CSV = "merlin-popis.csv";
/** One line per file: SHA-256, two spaces, name (the sha256sum format). */
export const MERLIN_PACKAGE_FINGERPRINTS = "otisci.sha256";

export type MerlinPackageZip = {
  readonly bytes: Uint8Array;
  /** Lowercase hex SHA-256 of `bytes`. */
  readonly sha256: string;
  /** The names in the ZIP, in order. */
  readonly names: readonly string[];
};

const NAME = /^[a-z0-9]+(?:[.-][a-z0-9]+)*$/u;

/** The ZIP of a roster, or throws when a fingerprint of the roster is not that of its file. */
export function buildMerlinPackageZip(
  roster: MerlinRoster,
  labels: MerlinLabels,
): MerlinPackageZip {
  const files = new Map<string, Uint8Array>();
  for (const file of roster.files) {
    if (!NAME.test(file.name) || files.has(file.name) || file.name === MERLIN_PACKAGE_CSV) {
      throw new Error("invalid merlin package file name");
    }
    files.set(file.name, file.bytes);
  }
  const named = new Set<string>();
  for (const row of roster.rows) {
    for (const [name, sha256] of [
      [row.pdfName, row.pdfSha256],
      [row.docxName, row.docxSha256],
    ] as const) {
      if (name === null && sha256 === null) continue;
      const bytes = name === null ? undefined : files.get(name);
      if (name === null || bytes === undefined || sha256Hex(bytes) !== sha256) {
        throw new Error("merlin roster and files disagree");
      }
      named.add(name);
    }
  }
  if (named.size !== files.size) throw new Error("merlin roster and files disagree");
  if (roster.studentIds.length !== roster.rows.length) {
    throw new Error("merlin roster and its students disagree");
  }
  const entries: ZipEntry[] = [
    {
      name: MERLIN_PACKAGE_CSV,
      data: new TextEncoder().encode(merlinRosterCsv(roster.rows, labels)),
    },
    ...roster.files.map((file) => ({ name: file.name, data: file.bytes })),
  ];
  const fingerprints = entries.map((entry) => `${sha256Hex(entry.data)}  ${entry.name}\n`).join("");
  entries.push({ name: MERLIN_PACKAGE_FINGERPRINTS, data: new TextEncoder().encode(fingerprints) });
  const bytes = writeZip(entries);
  return { bytes, sha256: sha256Hex(bytes), names: entries.map((entry) => entry.name) };
}
