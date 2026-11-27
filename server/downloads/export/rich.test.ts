import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { newNodeId, type CanonicalDocumentV4, type NodeId } from "../../domain/index.ts";
import { buildExportModel, renderDocx, type ExportCover, type ExportLabels } from "./index.ts";

const LABELS: ExportLabels = {
  listing: "Ispis",
  table: "Tablica",
  image: "Slika",
  source: "Izvor:",
  imageUnavailable: "Slika nije dostupna.",
  boxes: {
    definition: "D",
    theorem: "T",
    lemma: "L",
    corollary: "K",
    example: "P",
    remark: "N",
    proof: "Dokaz",
  },
};
const COVER: ExportCover = {
  institution: "Izmišljeno sveučilište",
  unit: "Izmišljeni fakultet",
  workType: "Seminarski rad",
  student: "Demo Student",
  mentor: "Demo Mentor",
};
const id = (n: number): NodeId =>
  newNodeId(() => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const ATT = "ffffffff-ffff-4fff-8fff-ffffffffffff";

/** A PNG header with the given size: enough for the export, which only reads the size. */
function png(width: number, height: number): Uint8Array {
  const out = new Uint8Array(33);
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(out.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return out;
}
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Names and text of the stored entries of a ZIP written by writeZip. */
function entries(zip: Uint8Array): Map<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const size = view.getUint32(at + 22, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen));
    out.set(
      name,
      new TextDecoder().decode(zip.subarray(at + 30 + nameLen, at + 30 + nameLen + size)),
    );
    at += 30 + nameLen + size;
  }
  return out;
}

const table = (n: number, extra: object = {}) => ({
  type: "table" as const,
  id: id(n),
  rows: [
    ["Grad", "Kućanstva", "Udio"],
    ["Izmišljeni Grad", "", "12 %"],
    ["", "", "9 <%>"],
  ],
  header: true,
  stripes: true,
  landscape: false,
  headerFill: "#dce6f2",
  title: "Kompostiranje",
  source: "izrada autora",
  ...extra,
});
const image = (n: number, extra: object = {}) => ({
  type: "image" as const,
  id: id(n),
  widthPercent: 50,
  align: "center" as const,
  landscape: false,
  ...extra,
});
const docOf = (...nodes: object[]): CanonicalDocumentV4 =>
  ({ schemaVersion: 4, sources: [], nodes }) as unknown as CanonicalDocumentV4;
const xmlOf = (doc: CanonicalDocumentV4, images?: Map<string, { bytes: Uint8Array }>) =>
  entries(renderDocx(buildExportModel(doc, LABELS), COVER, undefined, images));

describe("table (contract v4 §5.1)", () => {
  it("numbers tables and images separately, in order of appearance", () => {
    const model = buildExportModel(
      docOf(table(1), image(2), table(3, { title: undefined })),
      LABELS,
    );
    expect(model.blocks.map((b) => ("caption" in b ? b.caption : ""))).toEqual([
      "Tablica 1. Kompostiranje",
      "Slika 1.",
      "Tablica 2.",
    ]);
  });

  it("prints caption, header, fills, stripes, merges, escaped cells and source", () => {
    const doc =
      xmlOf(
        docOf(
          table(1, {
            merges: [{ row: 1, column: 0, rowSpan: 2, columnSpan: 2 }],
            cellFills: [{ row: 1, column: 2, color: "#fff2cc" }],
          }),
        ),
      ).get("word/document.xml") ?? "";
    expect(doc).toContain("Tablica 1. Kompostiranje");
    expect(doc).toContain("<w:tblHeader/>");
    expect(doc).toContain('w:fill="dce6f2"');
    expect(doc).toContain('w:fill="fff2cc"');
    expect(doc).toContain('w:fill="f2f2f2"');
    expect(doc).toContain('<w:gridSpan w:val="2"/><w:vMerge w:val="restart"/>');
    expect(doc).toContain('<w:gridSpan w:val="2"/><w:vMerge/>');
    expect(doc).toContain("9 &lt;%&gt;");
    expect(doc).toContain("Izvor: izrada autora");
    // Row 1 has 2 cells (merged area + one), row 2 the continuation and one: 3 + 2 + 2 cells.
    expect(doc.match(/<w:tc>/g)).toHaveLength(7);
  });

  it("puts a landscape table in its own section and returns to portrait", () => {
    const doc =
      xmlOf(
        docOf(table(1, { landscape: true }), { type: "paragraph", id: id(2), children: [] }),
      ).get("word/document.xml") ?? "";
    expect(doc).toContain('<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/>');
    expect(doc.match(/<w:sectPr>/g)).toHaveLength(3);
    // The cover's page break is replaced by the section break when the table opens the work.
    expect(doc.match(/w:type="page"/g)).toBeNull();
  });
});

describe("image (contract v4 §5.2)", () => {
  const bytes = png(200, 100);
  const node = image(1, {
    attachmentId: ATT,
    attachmentSha256: sha(bytes),
    crop: { left: 10, right: 10, top: 0, bottom: 0 },
    title: "Kompostište",
  });

  it("embeds the attachment with crop and size from the document", () => {
    const parts = entries(
      renderDocx(
        buildExportModel(docOf(node), LABELS),
        COVER,
        undefined,
        new Map([[ATT, { bytes }]]),
      ),
    );
    const doc = parts.get("word/document.xml") ?? "";
    expect(doc).toContain('<a:srcRect l="10000" t="0" r="10000" b="0"/>');
    // 50 % of 11906 - 2 * 1418 = 4535 twips wide; the cropped picture is 160 x 100 px.
    expect(doc).toContain('<wp:extent cx="2879725" cy="1799828"/>');
    expect(parts.has("word/media/image1.png")).toBe(true);
    expect(parts.get("word/_rels/document.xml.rels")).toContain('Target="media/image1.png"');
    expect(parts.get("[Content_Types].xml")).toContain('Extension="png"');
    expect(doc).toContain('<w:jc w:val="center"/>');
  });

  it("prints it as unavailable when the bytes do not match the hash, are missing or not an image", () => {
    const wrong = new Map([[ATT, { bytes: png(300, 100) }]]);
    const text = new Map([[ATT, { bytes: new TextEncoder().encode("not an image") }]]);
    const textNode = { ...node, attachmentSha256: sha(new TextEncoder().encode("not an image")) };
    for (const [doc, images] of [
      [docOf(node), wrong],
      [docOf(node), undefined],
      [docOf(node), new Map()],
      [docOf(textNode), text],
    ] as const) {
      const parts = xmlOf(doc, images);
      expect(parts.get("word/document.xml")).toContain("Slika nije dostupna.");
      expect([...parts.keys()].some((k) => k.startsWith("word/media/"))).toBe(false);
    }
  });

  it("prints an image without an attachment as unavailable and is deterministic", () => {
    const doc = docOf(image(1));
    expect(xmlOf(doc).get("word/document.xml")).toContain("Slika nije dostupna.");
    const a = renderDocx(
      buildExportModel(docOf(node), LABELS),
      COVER,
      undefined,
      new Map([[ATT, { bytes }]]),
    );
    const b = renderDocx(
      buildExportModel(docOf(node), LABELS),
      COVER,
      undefined,
      new Map([[ATT, { bytes }]]),
    );
    expect(sha(a)).toBe(sha(b));
  });
});
