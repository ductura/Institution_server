// SRV-1109: the files of a submitted work and the reader of their source. All
// names, texts and ids are invented.
import { createHash } from "node:crypto";

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

import { fileBaseName, renderWorkFiles, sha256Hex, sourceOf } from "./index.ts";

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

describe("sourceOf", () => {
  const row = {
    student_id: S,
    given_name: "Demo",
    family_name: "Anić",
    document_id: "rad-izmisljeni-1",
    submitted: true,
    revision: "7",
    body: "{}",
  };

  it("reads a work row and a row without a work", () => {
    expect(sourceOf(row)).toEqual({
      studentId: S,
      givenName: "Demo",
      familyName: "Anić",
      work: { documentId: "rad-izmisljeni-1", submitted: true, revision: 7, body: "{}" },
    });
    expect(
      sourceOf({ ...row, document_id: null, submitted: null, revision: null, body: null }),
    ).toEqual({ studentId: S, givenName: "Demo", familyName: "Anić", work: null });
  });

  it.each([
    ["an upper-case id", { student_id: S.toUpperCase() }],
    ["half a name pair", { given_name: null }],
    ["a revision that is not a number", { revision: "x" }],
    ["a missing text", { body: null }],
    ["a submission flag that is not a boolean", { submitted: "true" }],
    ["fields without a work", { document_id: null }],
  ])("throws on %s", (_, change) => {
    expect(() => sourceOf({ ...row, ...change })).toThrow();
  });
});
