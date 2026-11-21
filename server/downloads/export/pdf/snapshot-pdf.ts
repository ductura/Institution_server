import { createHash } from "node:crypto";

import type { CanonicalDocumentV4, ExportSnapshot } from "../../../domain/index.ts";

import { buildExportModel, renderDocx, type ExportLabels } from "../index.ts";

export type ConvertDocx = (docx: Buffer, mode: "plain" | "archive") => Promise<Buffer>;
export type VerifyPdfA = (pdf: Buffer) => Promise<{ outputSha256: string; xml: string }>;

const PART_2 = "<pdfaid:part>2</pdfaid:part>";
const LEVEL_B = "<pdfaid:conformance>B</pdfaid:conformance>";
const LEVEL_U = "<pdfaid:conformance>U</pdfaid:conformance>";

const sha256 = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");

function reportPasses(xml: string): boolean {
  if (/<!|<\?[^x]/u.test(xml)) return false;
  const reports = [...xml.matchAll(/<validationReport\b([^>]+)>([\s\S]*?)<\/validationReport>/gu)];
  if (reports.length !== 1 || (xml.match(/<validationReport\b/gu) ?? []).length !== 1) return false;
  const attributes = reports[0]![1]!;
  const checks = reports[0]![2]!;
  return (
    /(?:^|\s)isCompliant="true"(?:\s|$)/u.test(attributes) &&
    /(?:^|\s)jobEndStatus="normal"(?:\s|$)/u.test(attributes) &&
    /(?:^|\s)profileName="PDF\/A-2U validation profile"(?:\s|$)/iu.test(attributes) &&
    (attributes.match(/\bisCompliant\s*=/gu) ?? []).length === 1 &&
    (attributes.match(/\bprofileName\s*=/gu) ?? []).length === 1 &&
    (checks.match(/<details\b/gu) ?? []).length === 1 &&
    /<details\b[^>]+\bfailedRules="0"[^>]*>/u.test(checks)
  );
}

/** The one-byte XMP adjustment proven by the spike, subject to checking those exact bytes. */
function candidate2u(pdf: Buffer): Buffer {
  const source = pdf.toString("latin1");
  if (source.split(PART_2).length !== 2 || source.split(LEVEL_B).length !== 2) {
    throw new Error("Unexpected PDF/A identification");
  }
  return Buffer.from(source.replace(LEVEL_B, LEVEL_U), "latin1");
}

export async function createSnapshotPdf(
  snapshot: ExportSnapshot,
  labels: ExportLabels,
  convert: ConvertDocx,
  verify?: VerifyPdfA,
) {
  const model = buildExportModel(snapshot.document as CanonicalDocumentV4, labels);
  const docx = Buffer.from(renderDocx(model, snapshot.cover, snapshot.pageSetup));
  if (verify !== undefined) {
    try {
      const pdf = candidate2u(await convert(docx, "archive"));
      const outputSha256 = sha256(pdf);
      const report = await verify(Buffer.from(pdf));
      if (report.outputSha256 === outputSha256 && reportPasses(report.xml)) {
        return { pdf, format: "pdfa-2u", outputSha256, reportHash: sha256(report.xml) } as const;
      }
    } catch {
      // The unverified candidate is discarded, including its XMP identification.
    }
  }
  const pdf = await convert(docx, "plain");
  return { pdf, format: "pdf", outputSha256: sha256(pdf), reportHash: null } as const;
}
