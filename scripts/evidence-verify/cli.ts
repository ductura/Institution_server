// DAN-1563: offline check of one evidence package. Reads two files and
// nothing else; opens no connection.
//   node scripts/evidence-verify/cli.ts <package.json> <trust.json> [--json]
// Exit 0: no check failed. Exit 1: a check failed. Exit 2: wrong arguments or
// a file that cannot be read as JSON.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { type EvidenceCheck, type EvidenceVerifyReport, verifyEvidencePackage } from "./verify.ts";

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

export function formatReport(report: EvidenceVerifyReport): string {
  const lines = report.checks.map((check) => {
    const where = check.index === undefined ? "" : `, odsječak ${check.index + 1}`;
    const why = check.reason === undefined ? "" : ` (${check.reason}${where})`;
    return `${CHECK_LABELS[check.check]}: ${STATUS_LABELS[check.status]}${why}`;
  });
  lines.push(report.ok ? "Ishod: nijedna provjera nije pala." : "Ishod: zapis nije potvrđen.");
  return `${lines.join("\n")}\n`;
}

export async function main(args: readonly string[]): Promise<{ code: number; output: string }> {
  const paths = args.filter((arg) => arg !== "--json");
  if (paths.length !== 2 || args.length - paths.length > 1) {
    return {
      code: 2,
      output: "Upotreba: pnpm evidence:verify <paket.json> <povjerenje.json> [--json]\n",
    };
  }
  let files: unknown[];
  try {
    files = paths.map((path) => JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    return { code: 2, output: `Datoteka se ne može pročitati: ${(error as Error).message}\n` };
  }
  const report = await verifyEvidencePackage(files[0], files[1]);
  return {
    code: report.ok ? 0 : 1,
    output: args.includes("--json") ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { code, output } = await main(process.argv.slice(2));
  process.stdout.write(output);
  process.exitCode = code;
}
