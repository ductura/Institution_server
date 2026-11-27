import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { freezeExportSnapshot } from "../../../domain/index.ts";
import { A4_PAGE, type ExportLabels } from "../index.ts";
import { createSnapshotPdf } from "./index.ts";

const LABELS: ExportLabels = {
  listing: "Listing",
  table: "Table",
  image: "Figure",
  source: "Source:",
  imageUnavailable: "Image unavailable.",
  boxes: {
    definition: "",
    theorem: "",
    lemma: "",
    corollary: "",
    example: "",
    remark: "",
    proof: "",
  },
};
const SNAPSHOT = freezeExportSnapshot({
  document: { schemaVersion: 4, nodes: [], sources: [] },
  versionId: "demo-revision",
  kind: "saved",
  pageSetup: A4_PAGE,
  cover: { institution: "Demo", unit: "", workType: "", student: "", mentor: "" },
  expiresAt: "2026-11-22T00:00:00Z",
});
const PLAIN = Buffer.from("%PDF-1.7\n%%EOF");
const CANDIDATE = Buffer.from(
  "%PDF-1.7\n<pdfaid:part>2</pdfaid:part><pdfaid:conformance>B</pdfaid:conformance>\n%%EOF",
);
const REPORT =
  '<report><jobs><job><validationReport jobEndStatus="normal" profileName="PDF/A-2U validation profile" isCompliant="true"><details failedRules="0"/></validationReport></job></jobs></report>';
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const converter = () =>
  vi.fn(async (_docx: Buffer, mode: string) => (mode === "plain" ? PLAIN : CANDIDATE));

describe("PDF/A labelling is bound to the exact PDF and its report", () => {
  it("returns the verified archive bytes and both SHA-256 values", async () => {
    const convert = converter();
    const result = await createSnapshotPdf(SNAPSHOT, LABELS, convert, async (pdf) => ({
      outputSha256: sha(pdf),
      xml: REPORT,
    }));
    expect(result).toMatchObject({
      format: "pdfa-2u",
      outputSha256: sha(result.pdf),
      reportHash: sha(REPORT),
    });
    expect(result.pdf.toString()).toContain("<pdfaid:conformance>U</pdfaid:conformance>");
    expect(convert.mock.calls.map(([, mode]) => mode)).toEqual(["archive"]);
    expect(convert.mock.calls[0]![0].subarray(0, 2).toString()).toBe("PK");
  });

  it.each([
    ["not compliant", REPORT.replace('isCompliant="true"', 'isCompliant="false"'), false],
    ["wrong profile", REPORT.replace("PDF/A-2U", "PDF/A-2B"), false],
    ["duplicate report", REPORT + REPORT, false],
    ["malformed report", REPORT.replace("</validationReport>", ""), false],
    ["comment", `<!--${REPORT}-->`, false],
    ["failed rule", REPORT.replace('failedRules="0"', 'failedRules="1"'), false],
    ["wrong bytes", REPORT, true],
  ])("renders ordinary PDF for %s", async (_name, xml, wrongHash) => {
    const convert = converter();
    const result = await createSnapshotPdf(SNAPSHOT, LABELS, convert, async (pdf) => ({
      outputSha256: sha(wrongHash ? PLAIN : pdf),
      xml,
    }));
    expect(result).toMatchObject({
      pdf: PLAIN,
      format: "pdf",
      outputSha256: sha(PLAIN),
      reportHash: null,
    });
    expect(convert.mock.calls.map(([, mode]) => mode)).toEqual(["archive", "plain"]);
    expect(convert.mock.calls[0]![0]).toBe(convert.mock.calls[1]![0]);
  });

  it("converts directly to plain PDF when the verifier is absent", async () => {
    const convert = converter();
    expect(await createSnapshotPdf(SNAPSHOT, LABELS, convert)).toMatchObject({
      format: "pdf",
      reportHash: null,
    });
    expect(convert.mock.calls.map(([, mode]) => mode)).toEqual(["plain"]);
  });
});
