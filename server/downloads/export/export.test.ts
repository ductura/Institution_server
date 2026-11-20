import { createHash } from "node:crypto";
import { crc32 } from "node:zlib";
import { describe, expect, it } from "vitest";
import { newNodeId, type CanonicalDocumentV4, type NodeId } from "../../domain/index.ts";
import { buildExportModel, renderDocx, type ExportCover, type ExportLabels } from "./index.ts";

const LABELS: ExportLabels = {
  listing: "Listing",
  boxes: {
    definition: "Def",
    theorem: "Thm",
    lemma: "Lem",
    corollary: "Cor",
    example: "Ex",
    remark: "Rem",
    proof: "Proof",
  },
};
const COVER: ExportCover = {
  institution: "Izmisljeno sveuciliste",
  unit: "Izmisljeni fakultet",
  workType: "Seminarski rad",
  student: "Demo Student",
  mentor: "Demo Mentor",
  place: "Grad",
  date: "studeni 2026.",
};
const id = (n: number): NodeId =>
  newNodeId(() => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const t = (
  text: string,
  marks: CanonicalDocumentV4["nodes"] extends never ? never : unknown[] = [],
) => ({ type: "text" as const, text, marks: marks as never });

const DOC: CanonicalDocumentV4 = {
  schemaVersion: 4,
  sources: [],
  nodes: [
    { type: "heading", id: id(1), level: 1, children: [t('Kompost <1> & "gradovi"')] },
    {
      type: "paragraph",
      id: id(2),
      children: [
        t("a "),
        t("b", ["bold", "sup"]),
        t(" c", [{ type: "link", href: "https://primjer.hr/?a=1&b=2" }]),
      ],
    },
    { type: "heading", id: id(3), level: 2, children: [t("Podnaslov")] },
    { type: "codeBlock", id: id(4), caption: "Prosjek", children: [t("x = 1\ny = 2")] },
    { type: "codeBlock", id: id(5), children: [t("z")] },
    {
      type: "box",
      id: id(6),
      kind: "theorem",
      children: [{ type: "paragraph", id: id(7), children: [t("T")] }],
    },
    {
      type: "box",
      id: id(8),
      kind: "proof",
      children: [{ type: "paragraph", id: id(9), children: [t("P")] }],
    },
    { type: "formula", id: id(10), tex: "x^{2}" },
    { type: "pageBreak", id: id(11) },
    { type: "heading", id: id(12), level: 1, children: [t("Drugo")] },
  ],
};

function entries(zip: Uint8Array): Map<string, string> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out = new Map<string, string>();
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const crc = view.getUint32(at + 14, true);
    const size = view.getUint32(at + 22, true);
    const nameLen = view.getUint16(at + 26, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nameLen));
    const data = zip.subarray(at + 30 + nameLen, at + 30 + nameLen + size);
    expect(crc32(data)).toBe(crc);
    out.set(name, new TextDecoder().decode(data));
    at += 30 + nameLen + size;
  }
  expect(view.getUint32(at, true)).toBe(0x02014b50);
  return out;
}

describe("buildExportModel", () => {
  const model = buildExportModel(DOC, LABELS);
  it("derives title and numbers by kind", () => {
    expect(model.title).toBe('Kompost <1> & "gradovi"');
    expect(
      model.blocks.filter((b) => b.kind === "heading").map((b) => (b as { number: string }).number),
    ).toEqual(["1", "1.1", "2"]);
    expect(
      model.blocks.filter((b) => b.kind === "code").map((b) => (b as { caption: string }).caption),
    ).toEqual(["Listing 1. Prosjek", "Listing 2."]);
    expect(
      model.blocks.filter((b) => b.kind === "box").map((b) => (b as { label: string }).label),
    ).toEqual(["Thm 1.", "Proof"]);
    expect(model.blocks.find((b) => b.kind === "formula")).toMatchObject({ number: 1 });
  });
});

describe("renderDocx", () => {
  const model = buildExportModel(DOC, LABELS);
  const bytes = renderDocx(model, COVER);
  const parts = entries(bytes);
  it("is byte-identical for the same input", () => {
    const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
    expect(hash(renderDocx(model, COVER))).toBe(hash(bytes));
  });
  it("has the package parts and escapes text", () => {
    expect([...parts.keys()]).toEqual([
      "[Content_Types].xml",
      "_rels/.rels",
      "word/_rels/document.xml.rels",
      "word/styles.xml",
      "word/document.xml",
    ]);
    const doc = parts.get("word/document.xml") ?? "";
    expect(doc).toContain("Kompost &lt;1&gt; &amp; &quot;gradovi&quot;");
    expect(doc.indexOf("Seminarski rad")).toBeLessThan(doc.indexOf("Podnaslov"));
    expect(doc).toContain('<w:vertAlign w:val="superscript"/>');
    expect(doc).toContain('w:type="page"');
    expect(parts.get("word/_rels/document.xml.rels")).toContain(
      'Target="https://primjer.hr/?a=1&amp;b=2"',
    );
  });
  it("takes page shape from the setup, not the document", () => {
    const a5 = renderDocx(model, COVER, {
      widthTwips: 8391,
      heightTwips: 11906,
      marginTwips: 1134,
    });
    expect(entries(a5).get("word/document.xml")).toContain('w:w="8391"');
  });
});
