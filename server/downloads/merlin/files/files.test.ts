// SRV-1109: the files of a submitted work. All
// names, texts and ids are invented.
import { createHash } from "node:crypto";

import { PDFDocument, StandardFonts } from "pdf-lib";
import { describe, expect, it } from "vitest";

import {
  headingNode,
  newNodeId,
  paragraphNode,
  textNode,
  type CanonicalDocument,
  type NodeId,
} from "../../../domain/index.ts";
import { merlinHr } from "../../../../locales/index.ts";

import { fileBaseName, renderWorkFiles, sha256Hex } from "./index.ts";
import { wrap } from "./render.ts";

const id = (n: number): NodeId =>
  newNodeId(() => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`);
const DOC: CanonicalDocument = {
  schemaVersion: 1,
  nodes: [
    headingNode(id(1), 1, [textNode("Kućno kompostiranje u izmišljenom gradu")]),
    paragraphNode(id(2), [textNode("Izmišljeni odlomak o kompostu, "), textNode("bold", ["bold"])]),
    paragraphNode(id(3), [textNode("Znak bez glifa: 漢 i emoji 🌱.")]),
  ],
};
const S = "00000000-0000-4000-8000-0000000000e1";

describe("fileBaseName", () => {
  it("folds the Croatian letters and keeps the first 8 hex digits of the id", () => {
    expect(fileBaseName("Šimić-Đurđević", "Žana Čeč", S)).toBe(
      "simic-djurdjevic-zana-cec-00000000",
    );
    expect(fileBaseName("O'Neill", "Ana", "abcdef12-0000-4000-8000-000000000000")).toBe(
      "o-neill-ana-abcdef12",
    );
  });

  it("takes the whole id when asked", () => {
    expect(fileBaseName("Anić", "Demo", "abcdef12-3456-4789-8abc-def012345678", true)).toBe(
      "anic-demo-abcdef12345647898abcdef012345678",
    );
  });

  it("names a student without a name pair by the id alone", () => {
    expect(fileBaseName(null, null, "abcdef12-0000-4000-8000-000000000000")).toBe(
      "student-abcdef12",
    );
    expect(fileBaseName("漢", "字", "abcdef12-0000-4000-8000-000000000000")).toBe(
      "student-abcdef12",
    );
  });
});

describe("renderWorkFiles", () => {
  const input = { document: DOC, student: "Demo Anić", labels: merlinHr.exportLabels };

  it("gives a PDF and a DOCX, the same bytes for the same input", async () => {
    const first = await renderWorkFiles(input);
    const second = await renderWorkFiles(input);
    expect(Buffer.from(first.pdf).subarray(0, 5).toString("latin1")).toBe("%PDF-");
    expect(Buffer.from(first.docx).subarray(0, 2).toString("latin1")).toBe("PK");
    expect(sha256Hex(first.pdf)).toBe(sha256Hex(second.pdf));
    expect(sha256Hex(first.docx)).toBe(sha256Hex(second.docx));
  });

  it("puts the text of the work in the DOCX and changes the bytes with the text", async () => {
    const files = await renderWorkFiles(input);
    expect(Buffer.from(files.docx).toString("utf8")).toContain("Izmišljeni odlomak o kompostu");
    const other = await renderWorkFiles({
      ...input,
      document: { ...DOC, nodes: [paragraphNode(id(9), [textNode("Drugi tekst")])] },
    });
    expect(sha256Hex(other.pdf)).not.toBe(sha256Hex(files.pdf));
    expect(sha256Hex(other.docx)).not.toBe(sha256Hex(files.docx));
  });

  it("sha256Hex is the SHA-256 of the bytes", () => {
    const bytes = new TextEncoder().encode("izmisljeno");
    expect(sha256Hex(bytes)).toBe(createHash("sha256").update(bytes).digest("hex"));
  });
});

describe("wrap", () => {
  it("splits a word wider than the line, so no line passes the margin", async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    const url = `https://izmisljeno.invalid/${"a1b2c3".repeat(40)}`;
    const lines = wrap(font, `Izvor: ${url} kraj`, 11, 200);
    expect(lines.length).toBeGreaterThan(2);
    for (const line of lines) expect(font.widthOfTextAtSize(line, 11)).toBeLessThanOrEqual(200);
    expect(lines.join("").replaceAll(" ", "")).toBe(`Izvor:${url}kraj`);
  });

  it("keeps short words whole", async () => {
    const font = await (await PDFDocument.create()).embedFont(StandardFonts.Helvetica);
    expect(wrap(font, "jedan dva tri", 11, 500)).toEqual(["jedan dva tri"]);
  });
});
