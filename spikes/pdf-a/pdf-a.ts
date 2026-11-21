// What the spike does to the LibreOffice output and how it judges it.
import { PDFDict, PDFDocument, PDFName } from "pdf-lib";

import { runDocker } from "./docker.ts";
import { VERAPDF_IMAGE } from "./images.ts";

const CONFORMANCE_B = "<pdfaid:conformance>B</pdfaid:conformance>";
const CONFORMANCE_U = "<pdfaid:conformance>U</pdfaid:conformance>";
const PART_2 = "<pdfaid:part>2</pdfaid:part>";

/**
 * LibreOffice writes PDF/A-2b; level U adds only that all text maps to
 * Unicode (ISO 19005-2 6.2.11.7), which veraPDF checks. This changes the one
 * letter in the XMP identification, byte for byte, so offsets stay valid.
 * The result is called PDF/A only after veraPDF says isCompliant="true"
 * (D-206, D-284); this function proves nothing by itself.
 */
export function declarePdfA2u(pdf: Buffer): Buffer {
  const text = pdf.toString("latin1");
  if (text.split(PART_2).length !== 2)
    throw new Error("PDF does not declare PDF/A part 2 exactly once");
  if (text.split(CONFORMANCE_B).length !== 2)
    throw new Error("PDF does not declare conformance B exactly once");
  const out = Buffer.from(text.replace(CONFORMANCE_B, CONFORMANCE_U), "latin1");
  if (out.length !== pdf.length) throw new Error("identification change moved bytes");
  return out;
}

export type VeraPdfVerdict = {
  compliant: boolean;
  profile: string;
  failedRules: number;
  failedClauses: string[];
};

export function parseVeraPdfXml(xml: string): VeraPdfVerdict {
  const reports = [...xml.matchAll(/<validationReport\b([^>]*)>/gu)];
  if (reports.length !== 1)
    throw new Error(`expected one validationReport, found ${reports.length}`);
  const attributes = reports[0]?.[1] ?? "";
  const compliant = /\bisCompliant="(true|false)"/u.exec(attributes)?.[1];
  const profile = /\bprofileName="([^"]*)"/u.exec(attributes)?.[1];
  const failedRules = /<details\b[^>]*\bfailedRules="(\d+)"/u.exec(xml)?.[1];
  if (compliant === undefined || profile === undefined || failedRules === undefined) {
    throw new Error("veraPDF report is missing isCompliant, profileName or failedRules");
  }
  const failedClauses = [
    ...xml.matchAll(
      /<rule\b[^>]*\bclause="([^"]+)"[^>]*\btestNumber="(\d+)"[^>]*\bstatus="failed"/gu,
    ),
  ].map((match) => `${match[1] ?? "?"} t${match[2] ?? "?"}`);
  return {
    compliant: compliant === "true",
    profile,
    failedRules: Number(failedRules),
    failedClauses,
  };
}

/** veraPDF with the fixed profile `-f 2u` (D-206), no network, PDF on stdin. */
export async function validatePdfA2u(pdf: Buffer): Promise<VeraPdfVerdict & { wallMs: number }> {
  const args = [
    "run",
    "--rm",
    "-i",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--tmpfs=/tmp",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    VERAPDF_IMAGE,
    "-f",
    "2u",
    "--format",
    "xml",
  ];
  const result = await runDocker(args, pdf);
  const xml = result.stdout.toString("utf8");
  // veraPDF exits 1 for a non-compliant file; the report still decides.
  if (!xml.includes("<validationReport")) {
    throw new Error(`veraPDF gave no report (exit ${result.code}): ${result.stderr.slice(-2000)}`);
  }
  return { ...parseVeraPdfXml(xml), wallMs: result.wallMs };
}

export type PdfFacts = { pages: number; embeddedFonts: string[]; unembeddedFonts: string[] };

/** Page count and the font programs the PDF carries, without the subset tag. */
export async function inspectPdf(pdf: Buffer): Promise<PdfFacts> {
  const document = await PDFDocument.load(pdf, { updateMetadata: false });
  const embedded = new Set<string>();
  const unembedded = new Set<string>();
  for (const [, object] of document.context.enumerateIndirectObjects()) {
    if (
      !(object instanceof PDFDict) ||
      object.get(PDFName.of("Type")) !== PDFName.of("FontDescriptor")
    )
      continue;
    const name =
      object
        .get(PDFName.of("FontName"))
        ?.toString()
        .replace(/^\/(?:[A-Z]{6}\+)?/u, "") ?? "?";
    const hasProgram = ["FontFile", "FontFile2", "FontFile3"].some(
      (key) => object.get(PDFName.of(key)) !== undefined,
    );
    (hasProgram ? embedded : unembedded).add(name);
  }
  return {
    pages: document.getPageCount(),
    embeddedFonts: [...embedded].sort(),
    unembeddedFonts: [...unembedded].sort(),
  };
}
