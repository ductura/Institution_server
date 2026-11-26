// DAN-1563: the CLI mode of the evidence package check, beside the daily
// root (SRV-1311) and the portable record (SRV-1312):
//   node scripts/evidence-verify/index.ts --package <package.json> --trust <trust.json> [--json]
// Reads the two files and nothing else; opens no connection. Exit 0: no check
// failed. Exit 1: a check failed. Exit 2: wrong arguments or a file that
// cannot be read as JSON. The report names closed codes, never file content.
import { type EvidenceCheck, type EvidenceVerifyReport, verifyEvidencePackage } from "./package.ts";
import type { ReadFile } from "./verify.ts";

export const PACKAGE_USAGE =
  "Upotreba: node scripts/evidence-verify/index.ts --package <paket.json> --trust <povjerenje.json> [--json]";

/** Upper bounds of the files, asked before they are parsed. */
export const MAX_PACKAGE_FILE_BYTES = 512 * 1024 * 1024;
export const MAX_TRUST_FILE_BYTES = 1024 * 1024;

const CHECK_LABELS: Record<EvidenceCheck["check"], string> = {
  package: "Oblik paketa",
  chain: "Lanac odsječaka",
  receipts: "Potpisane potvrde",
  log: "Dnevni korijen",
  replay: "Ponovno izvođenje koraka",
};
const STATUS_LABELS: Record<EvidenceCheck["status"], string> = {
  ok: "U REDU",
  failed: "NIJE U REDU",
  skipped: "NIJE PROVJERENO",
};

export type PackageOutcome = { exitCode: 0 | 1 | 2; output: string };

export function formatReport(report: EvidenceVerifyReport): string {
  const lines = report.checks.map((check) => {
    const where = check.index === undefined ? "" : `, odsječak ${check.index + 1}`;
    const why = check.reason === undefined ? "" : ` (${check.reason}${where})`;
    return `${CHECK_LABELS[check.check]}: ${STATUS_LABELS[check.status]}${why}`;
  });
  lines.push(report.ok ? "Ishod: nijedna provjera nije pala." : "Ishod: zapis nije potvrđen.");
  return `${lines.join("\n")}\n`;
}

/** The two paths and the output form, or null. Each option at most once. */
export function parsePackageArgs(
  argv: readonly string[],
): { packagePath: string; trustPath: string; json: boolean } | null {
  const paths = new Map<string, string>();
  let json = false;
  for (let i = 0; i < argv.length; i++) {
    const name = argv[i];
    if (name === "--json" && !json) {
      json = true;
      continue;
    }
    const value = argv[i + 1];
    if (
      (name !== "--package" && name !== "--trust") ||
      paths.has(name) ||
      value === undefined ||
      value === "" ||
      value.startsWith("--")
    ) {
      return null;
    }
    paths.set(name, value);
    i++;
  }
  const packagePath = paths.get("--package");
  const trustPath = paths.get("--trust");
  if (packagePath === undefined || trustPath === undefined) return null;
  return { packagePath, trustPath, json };
}

function parseJson(bytes: Uint8Array | "too_large" | null): unknown {
  if (bytes === null || bytes === "too_large") return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export async function runPackageVerify(
  argv: readonly string[],
  readFile: ReadFile,
): Promise<PackageOutcome> {
  const args = parsePackageArgs(argv);
  if (args === null) return { exitCode: 2, output: `${PACKAGE_USAGE}\n` };
  const [packageBytes, trustBytes] = await Promise.all([
    readFile(args.packagePath, MAX_PACKAGE_FILE_BYTES),
    readFile(args.trustPath, MAX_TRUST_FILE_BYTES),
  ]);
  if (packageBytes === "too_large" || trustBytes === "too_large") {
    return { exitCode: 2, output: "NEISPRAVNO: file_too_large\n" };
  }
  const evidencePackage = parseJson(packageBytes);
  const trust = parseJson(trustBytes);
  if (evidencePackage === undefined || trust === undefined) {
    return { exitCode: 2, output: "NEISPRAVNO: file_unreadable\n" };
  }
  const report = await verifyEvidencePackage(evidencePackage, trust);
  return {
    exitCode: report.ok ? 0 : 1,
    output: args.json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report),
  };
}
